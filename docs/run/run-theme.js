// The demo's theme before the first paint (a file: the page's
// Content-Security-Policy allows only the site's own scripts).
(function () {
  try {
    if (localStorage.getItem("bridlewise:run-demo:theme") === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    }
  } catch (error) {
    /* The demo still works when storage is unavailable. */
  }
}());
