const Main = imports.ui.main;

let _id;

function _disableHotCorners() {
  // Disables all hot corners
  Main.layoutManager.hotCorners.forEach(function(hotCorner) {
    if (!hotCorner) {
      return;
    }

    hotCorner._toggleOverview = function() {};
    hotCorner._pressureBarrier._trigger = function() {};
  });
}

function init() {
}

function enable() {
  _disableHotCorners();
  // Hot corners may be re-created afterwards (for example, If there's a monitor change).
  // So we catch all changes.
  _id = Main.layoutManager.connect('hot-corners-changed', _disableHotCorners);
}

function disable() {
  // Disconnects the callback and re-creates the hot corners
  Main.layoutManager.disconnect(_id);
  Main.layoutManager._updateHotCorners();
}
