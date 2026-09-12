/* auth.js - the sign-in corner of the header.
   Reads /api/me and fills #auth-slot: "Sign in" for a visitor, the account
   name and a sign-out for a member. Nothing else on a page depends on it. */
(function () {
  var slot = document.getElementById('auth-slot');
  if (!slot) return;
  var here = location.pathname + location.search;
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  fetch('/api/me', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (me) {
    if (!me.signedIn) {
      slot.innerHTML = '<a href="/terms/?next=' + encodeURIComponent(here) + '">Sign in</a>';
      return;
    }
    var name = esc(me.name || me.provider);
    slot.innerHTML = '<span class="who" title="' + (me.accepted ? 'agreed to the terms' : 'terms not yet agreed') + '">'
      + (me.accepted ? '<span class="status-dot"></span>' : '') + name + '</span>'
      + ' <a href="/.auth/logout?post_logout_redirect_uri=' + encodeURIComponent(here) + '" title="sign out">←</a>';
  }).catch(function () { slot.innerHTML = ''; });
})();
