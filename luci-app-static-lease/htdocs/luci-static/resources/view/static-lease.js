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

	var gw = fv('_gateway', getGateway(sid)),
	    dns = getDns(sid),
	    d1 = fv('_dns1', dns[0] || ''),
	    d2 = fv('_dns2', dns[1] || '');

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
		var macs = section.formvalue(sid, 'mac');
		macs = (macs != null) ? L.toArray(macs) : list(sid, 'mac');
		uci.set('dhcp', sid, 'networkid',
			generateNetworkId(sid, macs, section.formvalue(sid, 'name') || uci.get('dhcp', sid, 'name')));
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

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callHostHints(), {}),
			L.resolveDefault(callDHCPLeases(), {}),
			uci.load('dhcp'),
			L.resolveDefault(uci.load('network'), null)
		]);
	},

	render: function(data) {
		var hosts = data[0] || {},
		    leases = (data[1] || {}).dhcp_leases || [],
		    subnets = getSubnets(),
		    m, s, o;

		m = new form.Map('dhcp', _('DHCP Static Leases'),
			_('Assign fixed IP addresses to DHCP clients and optionally hand out a different gateway and DNS servers to each of them.') + '<br />' +
			_('The required dnsmasq tag (<code>networkid</code>) is created and removed automatically. Everything is stored as standard OpenWrt configuration in <code>/etc/config/dhcp</code>, so the entries stay valid without this application.'));

		s = m.section(form.GridSection, 'host', _('Static Leases'));
		s.addremove = true;
		s.anonymous = true;
		s.sortable = true;
		s.nodescriptions = true;
		s.max_cols = 9;
		s.modaltitle = _('Edit static lease');
		s.addbtntitle = _('Add');

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

		o = s.option(form.Flag, 'enable', _('Enable'));
		o.default = o.enabled;
		o.editable = true;
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

			return E([], [
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
