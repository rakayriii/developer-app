"use client";

import { useState } from "react";
import GithubPhase2 from "@/components/github-phase2";

// Owns the tab state that GithubPhase2 expects from a parent, so the routed /github page and the
// hash workspace's #github tab render the identical workspace with the identical tabs.
export default function GithubSection({ tab }: { tab: string }) {
  const [activeTab, setActiveTab] = useState(tab);
  return <GithubPhase2 page="github" tab={activeTab} setTab={setActiveTab} />;
}
