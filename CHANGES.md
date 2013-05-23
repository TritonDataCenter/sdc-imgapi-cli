# imgadm-cli, joyent-imgadm, sdc-imgadm, updates-imgadm Changelog

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
