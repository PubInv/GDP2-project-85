#!/bin/sh
set -eu
umask 077
export IPFS_FORCE_PNET=1
ipfs init
cp /run/fixture-secrets/swarm.key "$IPFS_PATH/swarm.key"
chmod 400 "$IPFS_PATH/swarm.key"
ipfs bootstrap rm --all
ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001
ipfs config --json Addresses.Gateway '""'
ipfs config --json Addresses.Swarm '["/ip4/0.0.0.0/tcp/4001"]'
ipfs config --json Discovery.MDNS.Enabled false
ipfs config Routing.Type none
ipfs config --json Routing.DelegatedRouters '[]'
ipfs config --json Ipns.DelegatedPublishers '[]'
ipfs config --json AutoConf.Enabled false
ipfs config --json Provide.Enabled false
ipfs config --json Swarm.DisableNatPortMap true
ipfs config --json Swarm.RelayClient.Enabled false
ipfs config --json Swarm.RelayService.Enabled false
ipfs config --json AutoTLS.Enabled false
exec ipfs daemon --migrate=false
