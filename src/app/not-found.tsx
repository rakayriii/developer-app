import { redirect } from "next/navigation";

// Developer OS is a single workspace, not a set of independent pages: every destination lives under a
// known prefix (`/deployments`, `/servers`, ...) or under `/#hash`. A path outside that set is not a page
// this app owns, so it sends the browser to the real home rather than rendering a dead end.
//
// This exists because an unknown path otherwise renders Next's bare 404 - inside the application shell on
// a soft navigation, because the layout stays mounted while the page content is replaced. The result looks
// like the app broke. It is still a stale or mistyped link, so the fix belongs here and not in a
// `/admin/dashboard` route that does not correspond to anything real.
export default function NotFound() {
  redirect("/#overview");
}