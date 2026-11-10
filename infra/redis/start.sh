#!/bin/sh
set -eu

: "${NOT_BEFORE_REDIS_PASSWORD:?NOT_BEFORE_REDIS_PASSWORD is required}"

acl_file=/tmp/users.acl
umask 077
printf 'user default on >%s ~not-before:* +get +set +eval +ping\n' "${NOT_BEFORE_REDIS_PASSWORD}" >"${acl_file}"
unset NOT_BEFORE_REDIS_PASSWORD

exec redis-server \
  --aclfile "${acl_file}" \
  --appendonly yes \
  --appendfsync everysec \
  --dir /data \
  --save 60 1
