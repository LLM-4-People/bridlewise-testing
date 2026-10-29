// The lead theme before the first paint: loaded in the head, before the
// stylesheets apply, so a reader who chose Carbon never sees a Logbook flash.
// A file, not an inline script: the page's Content-Security-Policy allows
// only the site's own scripts ('self').
(function () {
  var root = document.documentElement;
  root.classList.add("js");
  try {
    if (localStorage.getItem("bridlewise-theme") === "carbon") root.dataset.theme = "carbon";
  } catch (error) {}
})();
