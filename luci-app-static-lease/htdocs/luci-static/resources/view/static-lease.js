'use strict';
'require view';
'require dom';
'require poll';
'require rpc';
'require uci';
'require form';
'require ui';

/*
 * DHCP static leases with per-host gateway and DNS.
 *
 * Everything is stored as native dnsmasq configuration in /etc/config/dhcp:
 *
 *   config host
 *       option name 'iQOO-12'
 *       option mac 'DC:2D:04:BE:DA:87'
 *       option ip '192.168.124.222'
 *       option networkid 'sl_dc2d04beda87'      <- generated automatically
 *       list dhcp_option '3,192.168.124.2'       <- gateway
 *       list dhcp_option '6,223.5.5.5,119.29.29.29' <- DNS
 *
 * /etc/init.d/dnsmasq turns this into
 *   --dhcp-host=DC:2D:04:BE:DA:87,set:sl_dc2d04beda87,192.168.124.222,iQOO-12
 *   --dhcp-option=tag:sl_dc2d04beda87,3,192.168.124.2
 * so no separate "config tag" section is needed and deleting the host
 * removes its options as well.
 */

var ID_PREFIX = 'sl_';

var callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

var callDHCPLeases = rpc.declare({
	object: 'luci-rpc',
	method: 'getDHCPLeases',
	expect: { '': {} }
});

function list(sid, opt) {
	var v = uci.get('dhcp', sid, opt);

	if (v == null || v === '')
		return [];

	return Array.isArray(v) ? v.slice() : String(v).split(/\s+/).filter(function(e) { return e != ''; });
}

/* kept as variables: jsmin mis-parses a regex literal directly after "return" */
var RE_GATEWAY = /^(3|option:router),/,
    RE_DNS = /^(6|option:dns-server),/;

function isGatewayOption(o) {
	return RE_GATEWAY.test(o);
}

function isDnsOption(o) {
	return RE_DNS.test(o);
}

function getGateway(sid) {
	var o = list(sid, 'dhcp_option').filter(isGatewayOption)[0];
	return o ? (o.split(',')[1] || '') : '';
}

function getDns(sid) {
	var o = list(sid, 'dhcp_option').filter(isDnsOption)[0];
	return o ? o.split(',').slice(1).filter(function(e) { return e != ''; }) : [];
}

function normalizeMac(mac) {
	return String(mac || '').trim().toUpperCase();
}

function ip4ToInt(ip) {
	var p = String(ip || '').split('.');

	if (p.length != 4)
		return null;

	for (var i = 0; i < 4; i++) {
		p[i] = parseInt(p[i], 10);
		if (isNaN(p[i]) || p[i] < 0 || p[i] > 255)
			return null;
	}

	return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function maskToPrefix(mask) {
	var m = ip4ToInt(mask), n = 0;

	if (m == null)
		return null;

	while (m & 0x80000000) { n++; m = (m << 1) >>> 0; }

	return n;
}

/* IPv4 subnets of the statically configured interfaces in /etc/config/network */
function getSubnets() {
	var res = [];

	uci.sections('network', 'interface').forEach(function(s) {
		if (s.proto != 'static')
			return;

		L.toArray(s.ipaddr).forEach(function(a) {
			var parts = a.split('/'),
			    addr = ip4ToInt(parts[0]),
			    prefix = parts[1] != null ? +parts[1] : maskToPrefix(s.netmask || '255.255.255.0');

			if (addr == null || prefix == null || isNaN(prefix))
				return;

			var mask = prefix ? (0xffffffff << (32 - prefix)) >>> 0 : 0;
			res.push({ iface: s['.name'], net: (addr & mask) >>> 0, mask: mask });
		});
	});

	return res;
}

function findInterface(subnets, ip) {
	var a = ip4ToInt(ip);

	if (a == null)
		return null;

	for (var i = 0; i < subnets.length; i++)
		if (((a & subnets[i].mask) >>> 0) == subnets[i].net)
			return subnets[i].iface;

	return null;
}

/* All tag names that are already used anywhere in the dhcp config. */
function usedTags(except_sid) {
	var used = {};

	uci.sections('dhcp').forEach(function(s) {
		if (s['.name'] == except_sid)
			return;

		used[s['.name']] = true;

		if (s.networkid)
			used[s.networkid] = true;

		if (s.interface)
			used[s.interface] = true;

		list(s['.name'], 'tag').forEach(function(t) { used[t] = true; });
	});

	return used;
}

function generateNetworkId(sid, macs, name) {
	var base;

	if (macs.length)
		base = macs[0].replace(/[^0-9A-Fa-f]/g, '').toLowerCase();
	else if (name)
		base = String(name).toLowerCase().replace(/[^a-z0-9_]/g, '_');
	else
		base = sid.replace(/[^A-Za-z0-9_]/g, '');

	var used = usedTags(sid),
	    id = ID_PREFIX + base,
	    n = 2;

	while (used[id])
		id = ID_PREFIX + base + '_' + (n++);

	return id;
}

/*
 * Rebuild the gateway/DNS part of dhcp_option for one host and take care of
 * the networkid. Options that were not created by this page are preserved.
 */
function syncHostOptions(section, sid) {
	var fv = function(opt, fallback) {
		var v = section.formvalue(sid, opt);
		return (v == null) ? fallback : String(v).trim();
	};

	var dns = getDns(sid),
	    macs = section.formvalue(sid, 'mac');

	setHostOptions(sid,
		fv('_gateway', getGateway(sid)),
		fv('_dns1', dns[0] || ''),
		fv('_dns2', dns[1] || ''),
		(macs != null) ? L.toArray(macs) : list(sid, 'mac'),
		section.formvalue(sid, 'name') || uci.get('dhcp', sid, 'name'));
}

function setHostOptions(sid, gw, d1, d2, macs, name) {
	gw = gw || ''; d1 = d1 || ''; d2 = d2 || '';

	var opts = list(sid, 'dhcp_option').filter(function(o) {
		return !isGatewayOption(o) && !isDnsOption(o);
	});

	if (gw)
		opts.push('3,' + gw);

	var servers = [ d1, d2 ].filter(function(e) { return e != ''; });

	if (servers.length)
		opts.push('6,' + servers.join(','));

	if (opts.length)
		uci.set('dhcp', sid, 'dhcp_option', opts);
	else
		uci.unset('dhcp', sid, 'dhcp_option');

	var nid = uci.get('dhcp', sid, 'networkid');

	if (opts.length && !nid) {
		uci.set('dhcp', sid, 'networkid', generateNetworkId(sid, macs || [], name));
	}
	else if (!opts.length && nid && nid.indexOf(ID_PREFIX) == 0) {
		uci.unset('dhcp', sid, 'networkid');
	}
}

function formatDuration(sec) {
	sec = +sec;

	if (isNaN(sec))
		return '-';

	if (sec <= 0)
		return _('expired');

	return '%t'.format(sec);
}

function findHostByMac(mac) {
	mac = normalizeMac(mac);

	return uci.sections('dhcp', 'host').filter(function(s) {
		return list(s['.name'], 'mac').some(function(m) { return normalizeMac(m) == mac; });
	})[0];
}

/*
 * iKuai "DHCP static allocation" CSV import / export.
 *
 *   id,enabled,interface,ip_addr,mac,cl_name,comment,gateway,dns1,dns2
 *   1,"yes","lan1","192.168.1.20","aa:bb:cc:dd:ee:ff","phone","","192.168.1.2","",""
 *
 * cl_name and comment are URL-encoded, "(none)" means no hostname, lines end
 * with CRLF.
 */
var IKUAI_COLUMNS = [ 'id', 'enabled', 'interface', 'ip_addr', 'mac', 'cl_name', 'comment', 'gateway', 'dns1', 'dns2' ],
    RE_MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/,
    RE_IP4 = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/,
    RE_HOSTNAME = /^[A-Za-z0-9_]([A-Za-z0-9_.-]{0,62}[A-Za-z0-9_])?$/,
    RE_BOM = /^﻿/,
    RE_ENC_EXTRA = /[!'()*]/g,
    RE_QUOTE = /"/g;

function parseCSV(text) {
	var rows = [], row = [], field = '', quoted = false, c;

	text = String(text).replace(RE_BOM, '');

	for (var i = 0; i < text.length; i++) {
		c = text.charAt(i);

		if (quoted) {
			if (c == '"') {
				if (text.charAt(i + 1) == '"') { field += '"'; i++; }
				else quoted = false;
			}
			else {
				field += c;
			}
		}
		else if (c == '"') {
			quoted = true;
		}
		else if (c == ',') {
			row.push(field);
			field = '';
		}
		else if (c == '\r' || c == '\n') {
			if (c == '\r' && text.charAt(i + 1) == '\n')
				i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		}
		else {
			field += c;
		}
	}

	if (field != '' || row.length) {
		row.push(field);
		rows.push(row);
	}

	return rows.filter(function(r) { return !(r.length == 1 && r[0].trim() == ''); });
}

function ikuaiDecode(s) {
	s = String(s || '').trim();

	try { s = decodeURIComponent(s); } catch (e) {}

	return (s == '(none)') ? '' : s;
}

function ikuaiEncode(s) {
	return encodeURIComponent(String(s || '')).replace(RE_ENC_EXTRA, function(c) {
		return '%' + c.charCodeAt(0).toString(16).toUpperCase();
	});
}

function csvQuote(v) {
	return '"' + String(v == null ? '' : v).replace(RE_QUOTE, '""') + '"';
}

/* Returns { rows: [...], errors: [...] } or throws on an unknown file format. */
function parseIkuaiCSV(text) {
	var table = parseCSV(text);

	if (!table.length)
		throw new Error(_('The file is empty'));

	var head = table[0].map(function(h) { return h.trim().toLowerCase(); }),
	    col = {};

	head.forEach(function(h, i) { col[h] = i; });

	if (col.ip_addr == null || col.mac == null)
		throw new Error(_('Unrecognized file: expected an iKuai CSV export with the columns ip_addr and mac'));

	var get = function(r, name) {
		return (col[name] != null && r[col[name]] != null) ? String(r[col[name]]).trim() : '';
	};

	var res = { rows: [], errors: [] };

	for (var i = 1; i < table.length; i++) {
		var r = table[i],
		    line = i + 1,
		    mac = normalizeMac(get(r, 'mac').replace(/-/g, ':')),
		    ip = get(r, 'ip_addr'),
		    name = ikuaiDecode(get(r, 'cl_name')),
		    comment = ikuaiDecode(get(r, 'comment')),
		    gw = get(r, 'gateway'),
		    d1 = get(r, 'dns1'),
		    d2 = get(r, 'dns2'),
		    bad = null;

		if (!RE_MAC.test(mac))
			bad = _('invalid MAC address');
		else if (!RE_IP4.test(ip))
			bad = _('invalid IP address');
		else if ((gw && !RE_IP4.test(gw)) || (d1 && !RE_IP4.test(d1)) || (d2 && !RE_IP4.test(d2)))
			bad = _('invalid gateway or DNS address');

		if (bad) {
			res.errors.push({ line: line, reason: bad });
			continue;
		}

		/* dnsmasq only accepts plain host names; keep anything else as remark */
		if (name && !RE_HOSTNAME.test(name)) {
			comment = comment ? '%s (%s)'.format(comment, name) : name;
			name = '';
		}

		if (!d1 && d2) {
			d1 = d2;
			d2 = '';
		}

		res.rows.push({
			line: line,
			mac: mac,
			ip: ip,
			name: name,
			comment: comment,
			gateway: gw,
			dns1: d1,
			dns2: d2,
			enabled: get(r, 'enabled').toLowerCase() != 'no'
		});
	}

	return res;
}

/* Decide what to do with every imported row. */
function planImport(rows, merge) {
	var seenMac = {}, seenIp = {}, hosts = merge ? uci.sections('dhcp', 'host') : [];

	return rows.map(function(r) {
		var p = { row: r, action: 'add', sid: null, reason: null };

		if (seenMac[r.mac]) {
			p.action = 'skip';
			p.reason = _('duplicate MAC address in file (line %d)').format(seenMac[r.mac]);
			return p;
		}

		if (seenIp[r.ip]) {
			p.action = 'skip';
			p.reason = _('duplicate IP address in file (line %d)').format(seenIp[r.ip]);
			return p;
		}

		seenMac[r.mac] = r.line;
		seenIp[r.ip] = r.line;

		var owner = null, ipOwner = null;

		hosts.forEach(function(h) {
			if (list(h['.name'], 'mac').some(function(m) { return normalizeMac(m) == r.mac; }))
				owner = h;
		});

		hosts.forEach(function(h) {
			if (h.ip == r.ip && (!owner || h['.name'] != owner['.name']))
				ipOwner = h;
		});

		if (ipOwner) {
			p.action = 'skip';
			p.reason = _('IP address already used by %s').format(ipOwner.name || list(ipOwner['.name'], 'mac')[0] || ipOwner['.name']);
		}
		else if (owner) {
			p.action = 'update';
			p.sid = owner['.name'];
		}

		return p;
	});
}

function applyImport(plan, merge) {
	var count = { add: 0, update: 0, skip: 0, removed: 0 };

	if (!merge) {
		uci.sections('dhcp', 'host').forEach(function(h) {
			uci.remove('dhcp', h['.name']);
			count.removed++;
		});
	}

	plan.forEach(function(p) {
		var r = p.row, sid;

		if (p.action == 'skip') {
			count.skip++;
			return;
		}

		sid = (p.action == 'update') ? p.sid : uci.add('dhcp', 'host');

		uci.set('dhcp', sid, 'mac', [ r.mac ]);
		uci.set('dhcp', sid, 'ip', r.ip);

		if (r.name) {
			uci.set('dhcp', sid, 'name', r.name);
			uci.set('dhcp', sid, 'dns', '1');
		}

		if (r.comment)
			uci.set('dhcp', sid, 'comment', r.comment);

		if (r.enabled)
			uci.unset('dhcp', sid, 'enable');
		else
			uci.set('dhcp', sid, 'enable', '0');

		setHostOptions(sid, r.gateway, r.dns1, r.dns2, [ r.mac ], r.name || uci.get('dhcp', sid, 'name'));

		count[p.action]++;
	});

	return count;
}

function buildIkuaiCSV() {
	var lines = [ IKUAI_COLUMNS.join(',') ], n = 1;

	uci.sections('dhcp', 'host').forEach(function(h) {
		var sid = h['.name'],
		    mac = list(sid, 'mac')[0],
		    dns = getDns(sid);

		if (!mac || !RE_IP4.test(h.ip || ''))
			return;

		lines.push([
			n++,
			csvQuote(h.enable == '0' ? 'no' : 'yes'),
			csvQuote('auto'),
			csvQuote(h.ip),
			csvQuote(normalizeMac(mac).toLowerCase()),
			csvQuote(ikuaiEncode(h.name)),
			csvQuote(ikuaiEncode(h.comment)),
			csvQuote(getGateway(sid)),
			csvQuote(dns[0] || ''),
			csvQuote(dns[1] || '')
		].join(','));
	});

	return lines.join('\r\n') + '\r\n';
}

function downloadFile(name, content, type) {
	var blob = new Blob([ content ], { type: type }),
	    url = URL.createObjectURL(blob),
	    a = E('a', { 'href': url, 'download': name, 'style': 'display:none' });

	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	window.setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callHostHints(), {}),
			L.resolveDefault(callDHCPLeases(), {}),
			uci.load('dhcp'),
			L.resolveDefault(uci.load('network'), null)
		]);
	},

	showImportDialog: function(m) {
		var result = null,
		    error = null,
		    preview = E('div', { 'style': 'max-height:50vh;overflow:auto;margin:1em 0' }),
		    merge = E('input', { 'type': 'checkbox', 'checked': 'checked' }),
		    fileInput = E('input', { 'type': 'file', 'accept': '.csv,text/csv' }),
		    okBtn;

		var label = function(p) {
			switch (p.action) {
			case 'add':    return E('span', { 'style': 'color:#27ae60' }, _('New'));
			case 'update': return E('span', { 'style': 'color:#2980b9' }, _('Update'));
			default:       return E('span', { 'style': 'color:#c0392b' }, '%s: %s'.format(_('Skip'), p.reason));
			}
		};

		var refresh = function() {
			okBtn.disabled = true;

			if (error) {
				dom.content(preview, E('p', { 'class': 'alert-message warning' }, error));
				return;
			}

			if (!result) {
				dom.content(preview, '');
				return;
			}

			var plan = planImport(result.rows, merge.checked),
			    n = { add: 0, update: 0, skip: result.errors.length },
			    existing = uci.sections('dhcp', 'host').length,
			    rows = [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('Hostname')),
					E('th', { 'class': 'th' }, _('Client IP')),
					E('th', { 'class': 'th' }, _('Client MAC')),
					E('th', { 'class': 'th' }, _('Gateway')),
					E('th', { 'class': 'th' }, _('DNS')),
					E('th', { 'class': 'th' }, _('Status')),
					E('th', { 'class': 'th' }, _('Action'))
				])
			    ];

			plan.forEach(function(p) {
				var r = p.row;

				n[p.action]++;
				rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td' }, r.name || (r.comment ? E('em', {}, r.comment) : '-')),
					E('td', { 'class': 'td' }, r.ip),
					E('td', { 'class': 'td' }, r.mac),
					E('td', { 'class': 'td' }, r.gateway || E('em', {}, _('Default'))),
					E('td', { 'class': 'td' }, [ r.dns1, r.dns2 ].filter(function(e) { return e; }).join(', ') || E('em', {}, _('Default'))),
					E('td', { 'class': 'td' }, r.enabled ? _('Activated') : _('Deactivated')),
					E('td', { 'class': 'td' }, label(p))
				]));
			});

			result.errors.forEach(function(e) {
				rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'colspan': 7, 'style': 'color:#c0392b' },
						_('Line %d skipped: %s').format(e.line, e.reason))
				]));
			});

			var notes = [
				E('p', {}, _('%d to add, %d to update, %d skipped.').format(n.add, n.update, n.skip))
			];

			if (!merge.checked && existing)
				notes.push(E('p', { 'class': 'alert-message warning' },
					_('Not merging: all %d current static leases will be deleted first.').format(existing)));

			dom.content(preview, [ E('div', {}, notes), E('table', { 'class': 'table' }, rows) ]);

			okBtn.disabled = !(n.add + n.update > 0);
		};

		fileInput.addEventListener('change', function() {
			var file = fileInput.files[0];

			result = error = null;

			if (!file) {
				refresh();
				return;
			}

			var reader = new FileReader();

			reader.onload = function() {
				try {
					result = parseIkuaiCSV(reader.result);
				}
				catch (e) {
					error = e.message;
				}

				refresh();
			};
			reader.onerror = function() {
				error = _('Unable to read the file');
				refresh();
			};
			reader.readAsText(file);
		});

		merge.addEventListener('change', refresh);

		okBtn = E('button', {
			'class': 'btn cbi-button cbi-button-positive important',
			'disabled': 'disabled',
			'click': ui.createHandlerFn(this, function() {
				var mergeMode = merge.checked,
				    count = applyImport(planImport(result.rows, mergeMode), mergeMode),
				    skipped = count.skip + result.errors.length;

				ui.hideModal();

				return m.save(null, true).then(function() {
					ui.addNotification(null, E('p', {},
						_('Import finished: %d added, %d updated, %d skipped. Click "Save & Apply" to activate the changes.')
							.format(count.add, count.update, skipped)), 'info');
				});
			})
		}, _('Import'));

		var dlg = ui.showModal(_('Import'), [
			E('p', {}, _('Select a CSV file exported from iKuai (DHCP server → DHCP static allocation → Export).')),
			E('div', { 'class': 'cbi-value' }, fileInput),
			E('label', {}, [ merge, ' ', _('Merge into current data') ]),
			E('div', { 'class': 'cbi-section-descr' },
				_('Merge: entries with the same MAC address are updated and new ones are added. Without merging, all current static leases are replaced by the file.')),
			preview,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
				' ',
				okBtn
			])
		]);

		if (dlg && dlg.style) {
			dlg.style.width = '960px';
			dlg.style.maxWidth = '95vw';
		}
	},

	render: function(data) {
		var hosts = data[0] || {},
		    leases = (data[1] || {}).dhcp_leases || [],
		    subnets = getSubnets(),
		    m, s, o;

		/* title is rendered by the view so that the toolbar can sit between title and table */
		m = new form.Map('dhcp');

		s = m.section(form.GridSection, 'host');
		s.addremove = true;
		s.anonymous = true;
		s.sortable = true;
		s.nodescriptions = true;
		s.max_cols = 12;
		s.modaltitle = _('Edit static lease');
		s.addbtntitle = _('Add');

		s.renderRowActions = function(sid) {
			var td = form.GridSection.prototype.renderRowActions.call(this, sid),
			    disabled = (uci.get('dhcp', sid, 'enable') == '0'),
			    btn = E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'title': disabled ? _('Activate') : _('Deactivate'),
				'click': ui.createHandlerFn(this, function() {
					if (disabled)
						uci.unset('dhcp', sid, 'enable');
					else
						uci.set('dhcp', sid, 'enable', '0');

					return m.save(null, true);
				})
			}, disabled ? _('Activate') : _('Deactivate'));

			var edit = td.querySelector('.cbi-button-edit');

			if (edit && edit.parentNode)
				edit.parentNode.insertBefore(btn, edit.nextSibling);
			else
				td.appendChild(btn);

			return td;
		};

		o = s.option(form.DummyValue, '_select', '');
		o.modalonly = false;
		o.textvalue = function(sid) {
			return E('input', { 'type': 'checkbox', 'class': 'static-lease-select', 'data-sid': sid });
		};

		o = s.option(form.Value, 'name', _('Hostname'));
		o.textvalue = function(sid) { return uci.get('dhcp', sid, 'name') || '-'; };
		o.datatype = 'hostname';
		o.rmempty = true;
		o.write = function(sid, value) {
			uci.set('dhcp', sid, 'name', value);
			uci.set('dhcp', sid, 'dns', '1');
		};
		o.remove = function(sid) {
			uci.unset('dhcp', sid, 'name');
			uci.unset('dhcp', sid, 'dns');
		};
		Object.keys(hosts).forEach(function(mac) {
			if (hosts[mac].name)
				o.value(hosts[mac].name);
		});

		o = s.option(form.Value, 'ip', _('Client IP'));
		o.datatype = 'or(ip4addr("nomask"),"ignore")';
		o.value('ignore', _('Ignore (do not answer)'));
		o.rmempty = true;
		o.validate = function(sid, value) {
			var macs = L.toArray(this.section.formvalue(sid, 'mac')),
			    name = this.section.formvalue(sid, 'name');

			if (!macs.length && !name)
				return _('One of hostname or MAC address must be specified!');

			if (!value || value == 'ignore')
				return true;

			var dup = uci.sections('dhcp', 'host').filter(function(h) {
				return h['.name'] != sid && h.ip == value;
			})[0];

			if (dup)
				return _('The IP address %h is already used by another static lease').format(value);

			return true;
		};
		Object.keys(hosts).forEach(function(mac) {
			L.toArray(hosts[mac].ipaddrs || hosts[mac].ipv4).forEach(function(ip) {
				o.value(ip, hosts[mac].name ? '%s (%s)'.format(ip, hosts[mac].name) : ip);
			});
		});

		o = s.option(form.DynamicList, 'mac', _('Client MAC'));
		o.datatype = 'macaddr';
		o.rmempty = true;
		o.cfgvalue = function(sid) {
			return list(sid, 'mac').map(normalizeMac);
		};
		o.write = function(sid, value) {
			uci.set('dhcp', sid, 'mac', L.toArray(value).map(normalizeMac));
		};
		o.validate = function(sid, value) {
			if (!value)
				return true;

			var mac = normalizeMac(value),
			    owner = findHostByMac(mac);

			if (owner && owner['.name'] != sid)
				return _('The MAC address %h is already used by another static lease').format(mac);

			return true;
		};
		Object.keys(hosts).forEach(function(mac) {
			var hint = hosts[mac].name || L.toArray(hosts[mac].ipaddrs || hosts[mac].ipv4)[0];
			o.value(normalizeMac(mac), hint ? '%s (%s)'.format(normalizeMac(mac), hint) : normalizeMac(mac));
		});

		o = s.option(form.Value, '_gateway', _('Gateway'),
			_('Leave empty to use the default gateway of the DHCP server.'));
		o.datatype = 'ip4addr("nomask")';
		o.placeholder = _('Default');
		o.rmempty = true;
		o.cfgvalue = function(sid) { return getGateway(sid); };
		o.textvalue = function(sid) { return getGateway(sid) || E('em', {}, _('Default')); };
		o.write = o.remove = function(sid) { syncHostOptions(this.section, sid); };

		/*
		 * dnsmasq only applies a static lease on the interface whose subnet
		 * contains its IP, so the interface is derived from the address.
		 * (match_tag on the interface tag does not work: the interface tag is
		 * set after dnsmasq has looked up the host entry.)
		 */
		o = s.option(form.DummyValue, '_iface', _('Bound interface'),
			_('Determined automatically from the IP address: a static lease only applies on the interface whose subnet contains it.'));
		o.cfgvalue = function(sid) {
			var ip = uci.get('dhcp', sid, 'ip');
			return findInterface(subnets, ip) || _('Auto');
		};

		o = s.option(form.Value, '_dns1', _('Primary DNS'),
			_('Leave both DNS fields empty to use the default DNS servers of the DHCP server.'));
		o.datatype = 'ip4addr("nomask")';
		o.placeholder = _('Default');
		o.rmempty = true;
		o.cfgvalue = function(sid) { return getDns(sid)[0] || ''; };
		o.textvalue = function(sid) { return getDns(sid)[0] || E('em', {}, _('Default')); };
		o.write = o.remove = function(sid) { syncHostOptions(this.section, sid); };

		o = s.option(form.Value, '_dns2', _('Secondary DNS'));
		o.datatype = 'ip4addr("nomask")';
		o.rmempty = true;
		o.cfgvalue = function(sid) { return getDns(sid)[1] || ''; };
		o.textvalue = function(sid) { return getDns(sid)[1] || '-'; };
		o.validate = function(sid, value) {
			if (value && !this.section.formvalue(sid, '_dns1'))
				return _('Please fill in the primary DNS first');
			return true;
		};
		o.write = o.remove = function(sid) { syncHostOptions(this.section, sid); };

		o = s.option(form.Value, 'comment', _('Remark'));
		o.textvalue = function(sid) { return uci.get('dhcp', sid, 'comment') || '-'; };
		o.rmempty = true;

		o = s.option(form.DummyValue, '_state', _('Status'));
		o.modalonly = false;
		o.textvalue = function(sid) {
			return (uci.get('dhcp', sid, 'enable') == '0')
				? E('span', { 'style': 'color:#c0392b' }, _('Deactivated'))
				: E('span', { 'style': 'color:#27ae60' }, _('Activated'));
		};

		o = s.option(form.Flag, 'enable', _('Enable'));
		o.default = o.enabled;
		o.modalonly = true;
		o.rmempty = true;

		o = s.option(form.Value, 'leasetime', _('Lease time'),
			_('Host-specific lease time, e.g. <code>5m</code>, <code>3h</code>, <code>7d</code> or <code>infinite</code>.'));
		o.modalonly = true;
		o.rmempty = true;

		o = s.option(form.DummyValue, '_tag', _('Tag'),
			_('Generated automatically when a gateway or DNS server is set.'));
		o.modalonly = true;
		o.cfgvalue = function(sid) { return uci.get('dhcp', sid, 'networkid') || '-'; };

		var self = this;

		return m.render().then(function(mapEl) {
			var table = E('table', { 'class': 'table', 'id': 'static-lease-clients' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('Hostname')),
					E('th', { 'class': 'th' }, _('Client IP')),
					E('th', { 'class': 'th' }, _('Client MAC')),
					E('th', { 'class': 'th' }, _('Lease time remaining')),
					E('th', { 'class': 'th' }, _('Type')),
					E('th', { 'class': 'th cbi-section-actions' }, '')
				])
			]);

			var update = function(leases) {
				var rows = leases.map(function(l) {
					var host = findHostByMac(l.macaddr),
					    btn;

					if (host) {
						btn = E('button', {
							'class': 'btn cbi-button cbi-button-edit',
							'click': ui.createHandlerFn(self, function() {
								return s.renderMoreOptionsModal(host['.name']);
							})
						}, _('Edit'));
					}
					else {
						btn = E('button', {
							'class': 'btn cbi-button cbi-button-apply',
							'click': ui.createHandlerFn(self, function() {
								var sid = uci.add('dhcp', 'host');

								uci.set('dhcp', sid, 'mac', [ normalizeMac(l.macaddr) ]);
								uci.set('dhcp', sid, 'ip', l.ipaddr);

								if (l.hostname) {
									uci.set('dhcp', sid, 'name', l.hostname);
									uci.set('dhcp', sid, 'dns', '1');
								}

								/* newer LuCI tracks the pending section on the map, older on the section */
								m.addedSection = sid;
								s.addedSection = sid;

								return s.renderMoreOptionsModal(sid);
							})
						}, _('Make static'));
					}

					return [
						l.hostname || '-',
						l.ipaddr,
						normalizeMac(l.macaddr),
						formatDuration(l.expires),
						host ? _('Static') : _('Dynamic'),
						btn
					];
				});

				cbi_update_table(table, rows, E('em', {}, _('There are no active leases')));
			};

			update(leases);

			poll.add(function() {
				return L.resolveDefault(callDHCPLeases(), {}).then(function(res) {
					update((res || {}).dhcp_leases || []);
				});
			}, 5);

			var selected = function() {
				return Array.prototype.map.call(
					document.querySelectorAll('.static-lease-select:checked'),
					function(cb) { return cb.getAttribute('data-sid'); });
			};

			var bulk = function(fn) {
				var sids = selected();

				if (!sids.length) {
					ui.addNotification(null, E('p', _('Please select at least one entry first')), 'warning');
					return Promise.resolve();
				}

				sids.forEach(fn);
				selectAll.checked = false;

				return m.save(null, true);
			};

			var selectAll = E('input', {
				'type': 'checkbox',
				'change': function(ev) {
					document.querySelectorAll('.static-lease-select').forEach(function(cb) {
						cb.checked = ev.target.checked;
					});
				}
			});

			var toolbar = E('div', { 'class': 'cbi-section', 'style': 'display:flex;flex-wrap:wrap;gap:.5em;align-items:center' }, [
				E('label', { 'style': 'margin-right:.5em' }, [ selectAll, ' ', _('Select all') ]),
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': ui.createHandlerFn(self, function() { return self.showImportDialog(m); })
				}, _('Import')),
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': function() {
						downloadFile('dhcp_static.csv', buildIkuaiCSV(), 'text/csv');
					}
				}, _('Export')),
				E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, function() {
						return bulk(function(sid) { uci.unset('dhcp', sid, 'enable'); });
					})
				}, _('Activate')),
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(self, function() {
						return bulk(function(sid) { uci.set('dhcp', sid, 'enable', '0'); });
					})
				}, _('Deactivate')),
				E('button', {
					'class': 'btn cbi-button cbi-button-negative',
					'click': ui.createHandlerFn(self, function() {
						var n = selected().length;

						if (n && !confirm(_('Delete %d selected static lease(s)?').format(n)))
							return;

						return bulk(function(sid) { uci.remove('dhcp', sid); });
					})
				}, _('Delete'))
			]);

			return E('div', { 'id': 'static-lease-view' }, [
				E('style', {}, '#static-lease-view .th { white-space: nowrap } #static-lease-view .cbi-section-actions .btn { margin: 1px } '),
				E('h2', {}, _('DHCP Static Leases')),
				E('div', { 'class': 'cbi-map-descr' }, [
					_('Assign fixed IP addresses to DHCP clients and optionally hand out a different gateway and DNS servers to each of them.'),
					E('br'),
					E('span', {}, _('The required dnsmasq tag (<code>networkid</code>) is created and removed automatically. Everything is stored as standard OpenWrt configuration in <code>/etc/config/dhcp</code>, so the entries stay valid without this application.'))
				]),
				E('h3', {}, _('Static Leases')),
				toolbar,
				mapEl,
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, _('DHCP Clients')),
					E('div', { 'class': 'cbi-section-descr' },
						_('Clients that currently hold a DHCP lease from this device. Use "Make static" to turn a lease into a static lease.')),
					table
				])
			]);
		});
	}
});
