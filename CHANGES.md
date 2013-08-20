# imgadm-cli, joyent-imgadm, sdc-imgadm, updates-imgadm Changelog

## 1.2.2

- [TOOLS-281]: '*-imgadm list --latest' to list just the latest (by `published_at`) images
  in a owner/name set.

## 1.2.1

- [IMGAPI-215] Default '*-imgadm list' output now includes a 'FLAGS'
  column that will show 'I' for incremental images, 'P' for public
  ones and 'X' for images with 'state' other than 'active'.

## 1.2.0

- [IMGAPI-241, backward incompatible] Change to the new http-signature
  Authorization header format per
  <http://tools.ietf.org/html/draft-cavage-http-signatures-00>

## 1.1.2

- Minor improvements to '*-imgadm enable|disable' help output.

## 1.1.1

- Change cli to report a "ClientError" when getting an IMGAPI client error.
  Previously these were reported as "InternalError"s.


## 1.1.0

- Add '-c COMPRESSION' support for 'addfile', 'create' and 'import'
  subcommands.
- Add 'import' subcmd.


## 1.0.1

- Make joyent-imgadm an exported 'bin'. I.e. use this to install the
  'joyent-imgadm' tool:

        npm install -g git+ssh://git@git.joyent.com:imgapi-cli.git

## 1.0.0

First release.
