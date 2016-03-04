/*
 * Copyright (c) 2015 Red Hat, Inc.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation; either version 2 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, see <http://www.gnu.org/licenses/>.
 */

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Pango = imports.gi.Pango;
const PkgKit = imports.gi.PackageKitGlib;
const Polkit = imports.gi.Polkit;
const Signals = imports.signals;
const St = imports.gi.St;

const EndSessionDialog = imports.ui.endSessionDialog;
const Main = imports.ui.main;
const ModalDialog = imports.ui.modalDialog;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;

const PkIface = '<node> \
<interface name="org.freedesktop.PackageKit"> \
    <method name="CreateTransaction"> \
        <arg type="o" name="object_path" direction="out"/> \
    </method> \
    <signal name="UpdatesChanged"/> \
</interface> \
</node>';

const PkOfflineIface = '<node> \
<interface name="org.freedesktop.PackageKit.Offline"> \
    <property name="UpdatePrepared" type="b" access="read"/> \
    <property name="TriggerAction" type="s" access="read"/> \
    <method name="Trigger"> \
        <arg type="s" name="action" direction="in"/> \
    </method> \
    <method name="Cancel"/> \
</interface> \
</node>';

const PkTransactionIface = '<node> \
<interface name="org.freedesktop.PackageKit.Transaction"> \
    <method name="SetHints"> \
        <arg type="as" name="hints" direction="in"/> \
    </method> \
    <method name="GetUpdates"> \
        <arg type="t" name="filter" direction="in"/> \
    </method> \
    <method name="UpdatePackages"> \
        <arg type="t" name="transaction_flags" direction="in"/> \
        <arg type="as" name="package_ids" direction="in"/> \
    </method> \
    <signal name="Package"> \
        <arg type="u" name="info" direction="out"/> \
        <arg type="s" name="package_id" direction="out"/> \
        <arg type="s" name="summary" direction="out"/> \
    </signal> \
    <signal name="Finished"> \
        <arg type="u" name="exit" direction="out"/> \
        <arg type="u" name="runtime" direction="out"/> \
    </signal> \
</interface> \
</node>';

const LoginManagerIface = '<node> \
<interface name="org.freedesktop.login1.Manager"> \
<method name="Reboot"> \
    <arg type="b" direction="in"/> \
</method> \
<method name="CanReboot"> \
    <arg type="s" direction="out"/> \
</method> \
</interface> \
</node>';

const PkProxy = Gio.DBusProxy.makeProxyWrapper(PkIface);
const PkOfflineProxy = Gio.DBusProxy.makeProxyWrapper(PkOfflineIface);
const PkTransactionProxy = Gio.DBusProxy.makeProxyWrapper(PkTransactionIface);
const LoginManagerProxy = Gio.DBusProxy.makeProxyWrapper(LoginManagerIface);

let pkProxy = null;
let pkOfflineProxy = null;
let loginManagerProxy = null;
let updatesDialog = null;
let extensionSettings = null;
let cancellable = null;

let updatesCheckInProgress = false;
let updatesCheckRequested = false;
let securityUpdates = [];

function getDetailText(period) {
    let text = _("Important security updates need to be installed.\n");
    if (period < 60)
        text += ngettext("You can close this dialog and get %d minute to finish your work.",
                         "You can close this dialog and get %d minutes to finish your work.",
                         period).format(period);
    else
        text += ngettext("You can close this dialog and get %d hour to finish your work.",
                         "You can close this dialog and get %d hours to finish your work.",
                         Math.floor(period / 60)).format(Math.floor(period / 60));
    return text;
}

const UpdatesDialog = new Lang.Class({
    Name: 'UpdatesDialog',
    Extends: ModalDialog.ModalDialog,

    _init: function(settings) {
        this.parent({ styleClass: 'end-session-dialog',
                      destroyOnClose: false });

        this._gracePeriod = settings.get_uint('grace-period');
        this._gracePeriod = Math.min(Math.max(10, this._gracePeriod), 24*60);
        this._lastWarningPeriod = settings.get_uint('last-warning-period');
        this._lastWarningPeriod = Math.min(Math.max(1, this._lastWarningPeriod), this._gracePeriod - 1);
        this._lastWarnings = settings.get_uint('last-warnings');
        this._lastWarnings = Math.min(Math.max(1, this._lastWarnings),
                                      Math.floor((this._gracePeriod - 1) / this._lastWarningPeriod));

        let messageLayout = new St.BoxLayout({ vertical: true,
                                               style_class: 'end-session-dialog-layout' });
        this.contentLayout.add(messageLayout,
                               { x_fill: true,
                                 y_fill: true,
                                 y_expand: true });

        let subjectLabel = new St.Label({ style_class: 'end-session-dialog-subject',
                                          style: 'padding-bottom: 1em;',
                                          text: _("Important security updates") });
        messageLayout.add(subjectLabel,
                          { x_fill:  false,
                            y_fill:  false,
                            x_align: St.Align.START,
                            y_align: St.Align.START });

        this._detailLabel = new St.Label({ style_class: 'end-session-dialog-description',
                                           style: 'padding-bottom: 0em;',
                                           text: getDetailText(this._gracePeriod) });
        this._detailLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._detailLabel.clutter_text.line_wrap = true;

        messageLayout.add(this._detailLabel,
                          { y_fill:  true,
                            y_align: St.Align.START });

        let buttons = [{ action: Lang.bind(this, this.close),
                         label:  _("Close"),
                         key:    Clutter.Escape },
                       { action: Lang.bind(this, this._done),
                         label:  _("Restart &amp; Install") }];

        this.setButtons(buttons);

        this._openTimeoutId = 0;
        this.connect('destroy', Lang.bind(this, this._clearOpenTimeout));

        this._startTimer();
    },

    _clearOpenTimeout: function() {
        if (this._openTimeoutId > 0) {
            GLib.source_remove(this._openTimeoutId);
            this._openTimeoutId = 0;
        }
    },

    tryOpen: function() {
        if (this._openTimeoutId > 0 || this.open())
            return;

        this._openTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1,
                                                       Lang.bind(this, function() {
                                                           if (!this.open())
                                                               return GLib.SOURCE_CONTINUE;

                                                           this._clearOpenTimeout();
                                                           return GLib.SOURCE_REMOVE;
                                                       }));
    },

    _startTimer: function() {
        this._secondsLeft = this._gracePeriod*60;

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, Lang.bind(this,
            function() {
                this._secondsLeft -= 1;
                let minutesLeft = this._secondsLeft / 60;
                let periodLeft = Math.floor(minutesLeft);

                if (this._secondsLeft == 60 ||
                    (periodLeft > 0 && periodLeft <= this._lastWarningPeriod * this._lastWarnings &&
                     minutesLeft % this._lastWarningPeriod == 0)) {
                    this.tryOpen();
                    this._detailLabel.text = getDetailText(periodLeft);
                }

                if (this._secondsLeft > 0) {
                    if (this._secondsLeft < 60) {
                        let seconds = EndSessionDialog._roundSecondsToInterval(this._gracePeriod*60, this._secondsLeft, 10);
                        this._detailLabel.text =
                            _("Important security updates need to be installed now.\n") +
                            ngettext("This computer will restart in %d second.",
                                     "This computer will restart in %d seconds.",
                                     seconds).format(seconds);
                    }
                    return GLib.SOURCE_CONTINUE;
                }

                this._done();
                return GLib.SOURCE_REMOVE;
            }));
        this.connect('destroy', Lang.bind(this, function() {
            if (this._timerId > 0) {
                GLib.source_remove(this._timerId);
                this._timerId = 0;
            }
        }));
    },

    _done: function() {
        this.emit('done');
        this.destroy();
    },

    getState: function() {
        return [this._gracePeriod, this._lastWarningPeriod, this._lastWarnings, this._secondsLeft];
    },

    setState: function(state) {
        [this._gracePeriod, this._lastWarningPeriod, this._lastWarnings, this._secondsLeft] = state;
    },
});
Signals.addSignalMethods(UpdatesDialog.prototype);

function showDialog() {
    if (updatesDialog)
        return;

    updatesDialog = new UpdatesDialog(extensionSettings);
    updatesDialog.tryOpen();
    updatesDialog.connect('destroy', function() { updatesDialog = null; });
    updatesDialog.connect('done', function() {
        if (pkOfflineProxy.TriggerAction == 'power-off' ||
            pkOfflineProxy.TriggerAction == 'reboot') {
            loginManagerProxy.RebootRemote(false);
        } else {
            pkOfflineProxy.TriggerRemote('reboot', function(result, error) {
                if (!error)
                    loginManagerProxy.RebootRemote(false);
                else
                    log('Failed to trigger offline update: %s'.format(error.message));
            });
        }
    });
}

function cancelDialog(save) {
    if (!updatesDialog)
        return;

    if (save) {
        let state = GLib.Variant.new('(uuuu)', updatesDialog.getState());
        global.set_runtime_state(Me.uuid, state);
    }
    updatesDialog.destroy();
}

function restoreExistingState() {
    let state = global.get_runtime_state('(uuuu)', Me.uuid);
    if (state === null)
        return false;

    global.set_runtime_state(Me.uuid, null);
    showDialog();
    updatesDialog.setState(state.deep_unpack());
    return true;
}

function syncState() {
    if (!pkOfflineProxy || !loginManagerProxy)
        return;

    if (restoreExistingState())
        return;

    if (!updatesCheckInProgress &&
        securityUpdates.length > 0 &&
        pkOfflineProxy.UpdatePrepared)
        showDialog();
    else
        cancelDialog();
}

function doPkTransaction(callback) {
    if (!pkProxy)
        return;

    pkProxy.CreateTransactionRemote(function(result, error) {
        if (error) {
            log('Error creating PackageKit transaction: %s'.format(error.message));
            checkUpdatesDone();
            return;
        }

        new PkTransactionProxy(Gio.DBus.system,
                               'org.freedesktop.PackageKit',
                               String(result),
                               function(proxy, error) {
                                   if (!error) {
                                       proxy.SetHintsRemote(
                                           ['background=true', 'interactive=false'],
                                           function(result, error) {
                                               if (error) {
                                                   log('Error connecting to PackageKit: %s'.format(error.message));
                                                   checkUpdatesDone();
                                                   return;
                                               }
                                               callback(proxy);
                                           });
                                   } else {
                                       log('Error connecting to PackageKit: %s'.format(error.message));
                                   }
                               });
    });
}

function pkUpdatePackages(proxy) {
    proxy.connectSignal('Finished', function(p, e, params) {
        let [exit, runtime] = params;

        if (exit == PkgKit.ExitEnum.CANCELLED_PRIORITY) {
            // try again
            checkUpdates();
        } else if (exit != PkgKit.ExitEnum.SUCCESS) {
            log('UpdatePackages failed: %s'.format(PkgKit.ExitEnum.to_string(exit)));
        }

        checkUpdatesDone();
    });
    proxy.UpdatePackagesRemote(1 << PkgKit.TransactionFlagEnum.ONLY_DOWNLOAD, securityUpdates);
}

function pkGetUpdates(proxy) {
    proxy.connectSignal('Package', function(p, e, params) {
        let [info, packageId, summary] = params;

        if (info == PkgKit.InfoEnum.SECURITY)
            securityUpdates.push(packageId);
    });
    proxy.connectSignal('Finished', function(p, e, params) {
        let [exit, runtime] = params;

        if (exit == PkgKit.ExitEnum.SUCCESS) {
            if (securityUpdates.length > 0) {
                doPkTransaction(pkUpdatePackages);
                return;
            }
        } else if (exit == PkgKit.ExitEnum.CANCELLED_PRIORITY) {
            // try again
            checkUpdates();
        } else {
            log('GetUpdates failed: %s'.format(PkgKit.ExitEnum.to_string(exit)));
        }

        checkUpdatesDone();
    });
    proxy.GetUpdatesRemote(0);
}

function checkUpdatesDone() {
    updatesCheckInProgress = false;
    if (updatesCheckRequested) {
        updatesCheckRequested = false;
        checkUpdates();
    } else {
        syncState();
    }
}

function checkUpdates() {
    if (updatesCheckInProgress) {
        updatesCheckRequested = true;
        return;
    }
    updatesCheckInProgress = true;
    securityUpdates = [];
    doPkTransaction(pkGetUpdates);
}

function initSystemProxies() {
    new PkProxy(Gio.DBus.system,
                'org.freedesktop.PackageKit',
                '/org/freedesktop/PackageKit',
                function(proxy, error) {
                    if (!error) {
                        pkProxy = proxy;
                        let id = pkProxy.connectSignal('UpdatesChanged', checkUpdates);
                        pkProxy._signalId = id;
                        checkUpdates();
                    } else {
                        log('Error connecting to PackageKit: %s'.format(error.message));
                    }
                },
                cancellable);
    new PkOfflineProxy(Gio.DBus.system,
                       'org.freedesktop.PackageKit',
                       '/org/freedesktop/PackageKit',
                       function(proxy, error) {
                           if (!error) {
                               pkOfflineProxy = proxy;
                               let id = pkOfflineProxy.connect('g-properties-changed', syncState);
                               pkOfflineProxy._signalId = id;
                               syncState();
                           } else {
                               log('Error connecting to PackageKit: %s'.format(error.message));
                           }
                       },
                       cancellable);
    new LoginManagerProxy(Gio.DBus.system,
                          'org.freedesktop.login1',
                          '/org/freedesktop/login1',
                          function(proxy, error) {
                              if (!error) {
                                  proxy.CanRebootRemote(cancellable, function(result, error) {
                                      if (!error && result == 'yes') {
                                          loginManagerProxy = proxy;
                                          syncState();
                                      } else {
                                          log('Reboot is not available');
                                      }
                                  });
                              } else {
                                  log('Error connecting to Login manager: %s'.format(error.message));
                              }
                          },
                          cancellable);
}

function init(metadata) {
}

function enable() {
    cancellable = new Gio.Cancellable();
    extensionSettings = Convenience.getSettings();
    Polkit.Permission.new("org.freedesktop.packagekit.trigger-offline-update",
                          null, cancellable, function(p, result) {
                              try {
                                  let permission = Polkit.Permission.new_finish(result);
                                  if (permission && permission.allowed)
                                      initSystemProxies();
                                  else
                                      throw(new Error('not allowed'));
                              } catch(e) {
                                  log('No permission to trigger offline updates: %s'.format(e.toString()));
                              }
                          });
}

function disable() {
    cancelDialog(true);
    cancellable.cancel();
    cancellable = null;
    extensionSettings = null;
    updatesDialog = null;
    loginManagerProxy = null;
    if (pkOfflineProxy) {
        pkOfflineProxy.disconnect(pkOfflineProxy._signalId);
        pkOfflineProxy = null;
    }
    if (pkProxy) {
        pkProxy.disconnectSignal(pkProxy._signalId);
        pkProxy = null;
    }
}
