<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# sdc-imgapi-cli

This is a CLI library that allows interacting with an
[IMGAPI](https://github.com/joyent/sdc-imgapi) instance.

This repository is part of the Joyent SmartDataCenter project (SDC).  For
contribution guidelines, issues, and general documentation, visit the main
[SDC](http://github.com/joyent/sdc) project page.

# Overview

There are typically two IMGAPI instances with which we interact:

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

    npm install -g git+ssh://git@github.com:joyent/sdc-imgapi-cli.git

# Development

Typically sdc-imgapi-cli development on a local SDC instance is done by:

- making edits to a clone of sdc-imgapi-cli.git on a Mac (likely Linux too, but
  that's untested) or a SmartOS development zone,

        git clone git@github.com:joyent/sdc-imgapi-cli.git
        cd sdc-imgapi-cli
        git submodule update --init   # not necessary first time
        vi

- building:

        make all
        make check

- syncing changes to a running SDC (typically a COAL running locally in VMWare)
  via:
        ./tools/rsync-to coal

- then testing changes in that SDC (e.g. COAL) by using the sdc-imgadm tool. For
  example, if changes are made to the `list` command then they can immediately
  be observed by running the following command in the SDC headnode:

  		sdc-imgadm list
