# joyent-imgadm, sdc-imgadm, updates-imgadm Changelog

## not yet released

## 2.2.3

- TOOLS-1636 Fix updates-imgadm et al to flush stdout on exit.
- IMGAPI-603 Support node v4 and later. Drop support for node v0.8.

## 2.2.2

- IMGAPI-586: `reload-auth-keys` subcommand: Change the endpoint URL, add the
  subcommand to the the help output. (Just a patch-level verbump because the
  old URL was never used on any "master" branch.)

## 2.2.1

- IMGAPI-579: `{joyent,updates,*}-imgadm reload-auth-keys` to call the
  AdminReloadAuthKeys endpoint. This is only relevant against IMGAPI servers
  that use HTTP Signature auth.

## 2.1.1

- IMGAPI-576: `JOYENT_IMGADM_URL=<url> joyent-imgadm ...` envvar support

## 2.1.0

- IMGAPI-536: Adds `*-imgadm change-stor ...` to change the backend storage of
  given image files. Adds `*-imgadm list -A ...` and `*-imgadm get -A` option
  to include "admin" fields (currently just `files.*.stor`).

## 2.0.1

- Fix for PUBAPI-1163 to avoid errors caused by multiple parallel sshpk versions

## 2.0.0

- Get the much cleaned up http-signature auth, keyId handling, etc. from PUBAPI-1146.

## 1.3.1

- IMGAPI-501: '*-imgadm update ...' doesn't allow property=value and top-level opts at the same time

## 1.3.0

- Support for IMGAPI server channels. Examples:

        updates-imgadm channels
        updates-imgadm list -o uuid,name,channels
        updates-imgadm -C release list
        sdc-imgadm import $uuid -S https://updates.joyent.com?channel=staging

## 1.2.5

- IMGAPI-421: '*-imgadm get-file ...' saved file is sometimes incomplete

## 1.2.4

- Support *unsetting* image manifest fields via the CLI, e.g.:

        # remove the 'description' for this image
        sdc-imgadm update UUID description=

## 1.2.3

- [IMGAPI-249]: Added suport for 'export' command.
- [IMGAPI-249]: CLI constructor now takes an array option called 'excludeCmds'
  which allows imgadm scripts to exclude specific commands to being exposed as
  needed. joyent-imgadm and updates-imgadm don't expose 'export' by default.

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

        npm install -g git+ssh://git@github.com:joyent/sdc-imgapi-cli.git

## 1.0.0

First release.
