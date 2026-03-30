// claude-frame-bridge.js
// Add this script to any site previewed in Claude Frame's iframe.
// It notifies the parent frame of URL changes (pushState, replaceState, popstate).
(function() {
  if (window.__rcBridge) return;
  window.__rcBridge = true;

  function notify() {
    window.parent.postMessage({ type: 'rc-url-change', url: location.href }, '*');
  }

  ['pushState', 'replaceState'].forEach(function(method) {
    var orig = history[method];
    history[method] = function() {
      var result = orig.apply(this, arguments);
      notify();
      return result;
    };
  });

  window.addEventListener('popstate', notify);
  notify();
})();
