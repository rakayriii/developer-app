// Deployment stages. Extracted so the local and remote target adapters and the engine can all refer to
// the same set without importing each other.

export type Stage = "validation" | "build" | "architecture" | "transfer" | "remote_image" | "container_startup" | "port" | "release_command" | "health_check" | "runtime" | "stop" | "restart" | "rollback";

export const deploymentStages: readonly Stage[] = [
  "validation", "build", "architecture", "transfer", "remote_image", "container_startup",
  "port", "release_command", "health_check", "runtime", "stop", "restart", "rollback",
];

// Persisted log streams. These are the names the deployment log UI groups by, so a remote deployment's
// transfer, image load, and remote container events land in their own readable sections.
export const stageStream: Record<Stage, string> = {
  validation: "validation",
  build: "build",
  architecture: "build",
  transfer: "transfer",
  remote_image: "remote_image",
  container_startup: "container",
  port: "system",
  release_command: "release",
  health_check: "health",
  runtime: "runtime",
  stop: "stop",
  restart: "restart",
  rollback: "rollback",
};

export class StagedFailure extends Error {
  stage: Stage;
  code: string;
  status = 409;

  constructor(stage: Stage, message: string, code = "health_check_failed") {
    super(message);
    this.stage = stage;
    this.code = code;
  }
}
