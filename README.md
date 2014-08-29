<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# a CLI for the IMGAPI

Repository: <git@git.joyent.com:imgapi-cli.git>
Browsing: <https://mo.joyent.com/imgapi-cli>
Who: Trent Mick
Docs: <https://mo.joyent.com/docs/imgapi-cli>
Tickets/bugs: <https://devhub.joyent.com/jira/browse/IMGAPI>


# Overview

There are typically two instances of the
[IMGAPI](https://mo.joyent.com/docs/imgapi/master/) with which we interact:

1. <https://images.joyent.com> The central repository of Joyent-vetted images
   for using on SmartOS instances and in SDC setups. There is a `joyent-imgadm`
   tool that is typically used for this.
2. The IMGAPI running in an SDC7 datacenter. A `sdc-imgadm` wrapper is provided
   in the headnode global zone for this.

Both `joyent-imgadm` and `sdc-imgadm` use the imgapi-cli tools from this repo.
Note that these two tools are distinct from the `imgadm` tool available in all
SmartOS installations.


# Installation

The 'joyent-imgadm' tool can be installed like so:

    npm install -g git+ssh://git@git.joyent.com/imgapi-cli.git


# Development

TODO
