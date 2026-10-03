import { getGithubAccount, githubFetch, type GithubAccount } from "@/lib/github/client";

export type GithubActivity = { type: "commit" | "pull_request" | "issue" | "repository"; action: string; repository: string; title: string; actor: string; timestamp: string; url: string };
type Event = { type: string; created_at: string; repo: { name: string }; actor: { login: string }; payload: { action?: string; ref?: string; commits?: { sha: string; message: string }[]; pull_request?: { title: string; html_url: string; merged_at: string | null }; issue?: { title: string; html_url: string }; ref_type?: string } };

export async function getGithubActivity(accessToken: string, options: { account?: GithubAccount; limit?: number; page?: number; perPage?: number }) {
  const account = options.account || await getGithubAccount(accessToken);
  const perPage = Math.min(options.perPage || 50, 50);
  const page = Math.max(options.page || 1, 1);
  const events = await githubFetch<Event[]>(`/users/${encodeURIComponent(account.login)}/events?per_page=${perPage}&page=${page}`, accessToken);
  const items: GithubActivity[] = [];
  for (const event of events) {
    const repository = event.repo?.name || "";
    const actor = event.actor?.login || "";
    if (!repository || !actor || !event.created_at) continue;
    if (event.type === "PushEvent" && event.payload.commits) {
      for (const commit of event.payload.commits) items.push({ type: "commit", action: "pushed", repository, title: commit.message.split("\n")[0], actor, timestamp: event.created_at, url: `https://github.com/${repository}/commit/${commit.sha}` });
    } else if (event.type === "PullRequestEvent" && event.payload.pull_request) {
      const action = event.payload.action === "closed" && event.payload.pull_request.merged_at ? "merged" : event.payload.action || "updated";
      items.push({ type: "pull_request", action, repository, title: event.payload.pull_request.title, actor, timestamp: event.created_at, url: event.payload.pull_request.html_url });
    } else if (event.type === "IssuesEvent" && event.payload.issue) {
      items.push({ type: "issue", action: event.payload.action || "updated", repository, title: event.payload.issue.title, actor, timestamp: event.created_at, url: event.payload.issue.html_url });
    } else if (event.type === "CreateEvent" || event.type === "ForkEvent" || event.type === "WatchEvent") {
      items.push({ type: "repository", action: event.type.replace("Event", "").toLowerCase(), repository, title: event.payload.ref || event.payload.ref_type || repository, actor, timestamp: event.created_at, url: `https://github.com/${repository}` });
    }
  }
  return { items: items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, options.limit || 30), hasNextPage: events.length === perPage };
}
