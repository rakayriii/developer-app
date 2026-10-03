import { request } from "node:http";

type DockerResponse<T> = { statusCode: number; body: T };

export type DockerInfo = { serverVersion: string; apiVersion: string; containersRunning: number; containersStopped: number; images: number };
export type DockerContainer = { id: string; name: string; image: string; status: string; state: string; created: string; ports: string };

class DockerError extends Error {
  constructor(public code: "unavailable" | "permission_denied" | "timeout" | "malformed" | "http", message: string, public status = 503) { super(message); }
}

export { DockerError };

function socketPath() {
  return process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";
}

async function dockerRequest<T>(path: string): Promise<DockerResponse<T>> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socketPath(), path, method: "GET", headers: { Accept: "application/json" }, timeout: 5000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        let parsed: T;
        try { parsed = JSON.parse(body) as T; } catch { reject(new DockerError("malformed", "Docker returned an invalid response.", 502)); return; }
        resolve({ statusCode: response.statusCode || 502, body: parsed });
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new DockerError("timeout", "Docker daemon did not respond in time.", 504)); });
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES") reject(new DockerError("permission_denied", "Docker access is not permitted.", 503));
      else if (error.code === "ENOENT" || error.code === "ECONNREFUSED") reject(new DockerError("unavailable", "Docker daemon is unavailable.", 503));
      else reject(new DockerError("unavailable", "Docker daemon is unavailable.", 503));
    });
    req.end();
  });
}

type DockerInfoResponse = { ServerVersion?: string; ApiVersion?: string; ContainersRunning?: number; ContainersStopped?: number; Images?: number };
type DockerVersionResponse = { ApiVersion?: string };
type DockerContainerResponse = { Id: string; Names?: string[]; Image: string; Status: string; State: string; Created: number; Ports?: { PublicPort?: number; PrivatePort?: number; Type?: string }[] };

function assertResponse<T>(response: DockerResponse<T>): T {
  if (response.statusCode < 200 || response.statusCode >= 300) throw new DockerError("http", "Docker rejected the request.", response.statusCode === 403 ? 503 : 502);
  return response.body;
}

export async function getDockerInfo(): Promise<DockerInfo> {
  const [infoResponse, versionResponse] = await Promise.all([dockerRequest<DockerInfoResponse>("/info"), dockerRequest<DockerVersionResponse>("/version")]);
  const value = assertResponse(infoResponse);
  const version = assertResponse(versionResponse);
  return { serverVersion: value.ServerVersion || "Unknown", apiVersion: version.ApiVersion || value.ApiVersion || "Unknown", containersRunning: value.ContainersRunning || 0, containersStopped: value.ContainersStopped || 0, images: value.Images || 0 };
}

export async function getDockerContainers(): Promise<DockerContainer[]> {
  const values = assertResponse(await dockerRequest<DockerContainerResponse[]>("/containers/json?all=true"));
  if (!Array.isArray(values)) throw new DockerError("malformed", "Docker returned an invalid container list.", 502);
  return values.map((container) => ({ id: container.Id, name: container.Names?.[0]?.replace(/^\//, "") || container.Id.slice(0, 12), image: container.Image, status: container.Status, state: container.State, created: container.Created ? new Date(container.Created * 1000).toISOString() : "", ports: (container.Ports || []).map((port) => port.PublicPort ? `${port.PublicPort}:${port.PrivatePort}/${port.Type || "tcp"}` : `${port.PrivatePort}/${port.Type || "tcp"}`).join(", ") || "-" }));
}
