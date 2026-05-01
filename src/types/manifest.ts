export type ArgsMode = "env" | "argv" | "stdin-json";

export type PlatformId = "macos" | "windows";

export interface CommandSpec {
  command: string;
  args?: string[];
  shell?: boolean;
  cwd?: string;
}

export interface EntrySpec extends CommandSpec {
  argsMode?: ArgsMode;
}

export interface PlatformBlock {
  entry: EntrySpec;
  install?: CommandSpec;
  uninstall?: CommandSpec;
  preRun?: CommandSpec;
}

export type WhenClause = Record<
  string,
  string | number | boolean | null | Array<string | number | boolean>
>;

export type EnumOption =
  | string
  | { value: string | number | boolean; label?: string };

export interface InputBase {
  id: string;
  label?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  when?: WhenClause;
}

export type InputSpec =
  | (InputBase & {
      type: "string";
      multiline?: boolean;
      pattern?: string;
      minLength?: number;
      maxLength?: number;
    })
  | (InputBase & {
      type: "number";
      min?: number;
      max?: number;
      step?: number;
      integer?: boolean;
    })
  | (InputBase & { type: "boolean" })
  | (InputBase & {
      type: "enum";
      options: EnumOption[];
      multiple?: boolean;
    })
  | (InputBase & { type: "file"; accept?: string[] })
  | (InputBase & { type: "files"; accept?: string[] })
  | (InputBase & { type: "directory" })
  | (InputBase & { type: "password" })
  | (InputBase & { type: "date"; minDate?: string; maxDate?: string })
  | (InputBase & { type: "json" });

export type InputType = InputSpec["type"];

export interface OutputSpec {
  id: string;
  label?: string;
  description?: string;
  type: "file" | "directory" | "text";
  required?: boolean;
  suggested?: string;
  accept?: string[];
}

export interface Sandbox {
  image: string;
}

export interface Manifest {
  name: string;
  id?: string;
  description?: string;
  version?: string;
  /** runnerx app version at the time the script was created. Stamped by the
   *  AI flows; preserved across edits so future runtime checks can adapt to
   *  schema/behavior drift. */
  appVersion?: string;
  icon?: string;
  category?: string;
  tags?: string[];
  readme?: string;
  sandbox?: Sandbox;
  macos?: PlatformBlock;
  windows?: PlatformBlock;
  inputs?: InputSpec[];
  outputs?: OutputSpec[];
}

export interface InstallState {
  version: number;
  kind: "host" | "sandbox";
  image?: string;
  baseImage?: string;
  installedAt?: string;
}

export interface ScriptInfo {
  id: string;
  dir: string;
  manifest: Manifest;
  installed: boolean;
  installState?: InstallState;
  iconDataUrl?: string;
  readmePath?: string;
  supportedPlatforms: PlatformId[];
  supportedOnCurrentPlatform: boolean;
}

export type ResultPayload =
  | { type: "table"; title?: string; columns: string[]; rows: unknown[][] }
  | { type: "image"; path: string; label?: string }
  | { type: "file"; path: string; label?: string }
  | { type: "json"; data: unknown; label?: string }
  | { type: "text"; data: string; label?: string };

export type RunMode = "script" | "install" | "uninstall";

export type RunEvent =
  | { kind: "started"; runId: string; mode: RunMode }
  | { kind: "progress"; runId: string; value: number; message?: string }
  | { kind: "log"; runId: string; level: "info" | "warn" | "error"; message: string }
  | { kind: "stdout"; runId: string; line: string }
  | { kind: "stderr"; runId: string; line: string }
  | { kind: "result"; runId: string; payload: ResultPayload }
  | { kind: "exit"; runId: string; code: number | null; cancelled: boolean; mode: RunMode };

export interface ScanResult {
  scripts: ScriptInfo[];
  errors: { dir: string; message: string }[];
}
