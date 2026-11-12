/* Plan B: live JSON is not in this repo. The desk opens once as {URL}#d={DATA_PATH}
   and stores DATA_PATH in localStorage. DATA_PATH is never written into these files. */
(function () {
  var hash = window.location.hash || "";
  var match = /(?:^|#|&)d=([^&]+)/.exec(hash);
  if (match && match[1]) {
    try {
      window.localStorage.setItem("DATA_PATH", decodeURIComponent(match[1]));
    } catch (e) {}
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }
})();
