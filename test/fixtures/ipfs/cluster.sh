#!/bin/sh
set -eu
umask 077
export CLUSTER_SECRET="$(cat /run/fixture-secrets/cluster-secret)"
ipfs-cluster-service init --consensus raft
unset CLUSTER_SECRET
exec ipfs-cluster-service daemon "$@"
