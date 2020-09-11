#!/bin/bash
#
# This is a wrapper `openssl` that generates SRI hashes for CSS and JS files.
# It takes the path of the file to generate the hashes for as an argument.
#

set -e

SHA256HASH=`openssl dgst -sha256 -binary $1 | openssl base64 -A`
SHA384HASH=`openssl dgst -sha384 -binary $1 | openssl base64 -A`
SHA512HASH=`openssl dgst -sha512 -binary $1 | openssl base64 -A`

echo "SRI hashes for $1 are:"
echo "sha256-$SHA256HASH sha384-$SHA384HASH sha512-$SHA512HASH"
