# SPDX-License-Identifier: Apache-2.0

include $(TOPDIR)/rules.mk

LUCI_TITLE:=DHCP static leases with per-host gateway and DNS
LUCI_DESCRIPTION:=Manage DHCP static leases and hand out a different gateway and DNS servers to each client. The dnsmasq tag is created automatically and everything is stored as standard /etc/config/dhcp configuration.
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=tcpqueue

LUCI_URL:=https://github.com/tcpqueue/luci-app-static-lease
LUCI_MAINTAINER:=tcpqueue

# Works both inside the LuCI feed (applications/) and as an external package
# placed in package/ of an OpenWrt / ImmortalWrt buildroot.
include $(if $(wildcard ../../luci.mk),../../luci.mk,$(TOPDIR)/feeds/luci/luci.mk)

# call BuildPackage - OpenWrt buildroot signature
