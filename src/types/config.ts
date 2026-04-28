export type SandboxNetwork = "none" | "bridge" | "host";

export interface SandboxConfig {
  network: SandboxNetwork;
}

export interface AppConfig {
  sandbox: SandboxConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  sandbox: { network: "bridge" },
};
