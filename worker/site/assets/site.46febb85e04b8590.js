// Progressive enhancement only: the site is fully usable without this file.
(function () {
  "use strict";

  // Mark the current page in the navigation.
  var here = location.pathname.replace(/\/index\.html$/, "/");
  document.querySelectorAll(".site-header nav a").forEach(function (a) {
    var target = new URL(a.href, location.origin).pathname;
    if (target === here || (here.indexOf("/blog/") === 0 && target === "/blog.html")) {
      a.setAttribute("aria-current", "page");
    }
  });

  // The contact form is a static demo: say so instead of pretending to send.
  var form = document.querySelector("form[data-static]");
  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var note = form.querySelector("[data-note]");
      if (note) {
        note.textContent =
          "This form is not connected to a backend yet. Please email us instead.";
        note.className = "small";
      }
    });
  }
})();
