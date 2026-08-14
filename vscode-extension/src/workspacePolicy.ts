import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export enum OperationRisk {
  READ_ONLY = 'READ_ONLY',
  NORMAL_WRITE = 'NORMAL_WRITE',
  HIGH_RISK = 'HIGH_RISK',
}

export const operationRisk: Record<string, OperationRisk> = {
  READ: OperationRisk.READ_ONLY,
  SEARCH: OperationRisk.READ_ONLY,
  PROJECT_INFO: OperationRisk.READ_ONLY,
  EDIT_SOURCE_FILE: OperationRisk.NORMAL_WRITE,
  CREATE_SOURCE_FILE: OperationRisk.NORMAL_WRITE,
  DELETE_FILE: OperationRisk.HIGH_RISK,
  RENAME_MANY_FILES: OperationRisk.HIGH_RISK,
  MODIFY_ENV: OperationRisk.HIGH_RISK,
  MODIFY_CREDENTIAL_FILE: OperationRisk.HIGH_RISK,
  DESTRUCTIVE_COMMAND: OperationRisk.HIGH_RISK,
};

const SENSITIVE_NAMES = [
  /^\.env(?:\..+)?$/i,
  /\.(?:pem|key)$/i,
  /^id_(?:rsa|ed25519)$/i,
  /^credentials(?:\..+)?$/i,
  /^secrets?(?:\..+)?$/i,
];

export function isSensitiveFile(filePath: string): boolean {
  return SENSITIVE_NAMES.some((pattern) => pattern.test(path.basename(filePath)));
}

export class WorkspaceGuard {
  constructor(private readonly workspaceRoots: readonly string[]) {
    if (workspaceRoots.length === 0) throw new Error('No VS Code workspace folder is open.');
  }

  async resolveRelativePath(requestedPath: string, rootIndex = 0): Promise<string> {
    if (!requestedPath || requestedPath.includes('\0') || path.isAbsolute(requestedPath)) {
      throw new Error('Workspace paths must be relative.');
    }
    const root = this.workspaceRoots[rootIndex];
    if (!root) throw new Error('Requested workspace root is unavailable.');

    const canonicalRoot = await fs.realpath(root);
    const resolved = path.resolve(canonicalRoot, requestedPath);
    this.assertInside(canonicalRoot, resolved);

    const canonicalTarget = await this.canonicalizePotentialPath(resolved);
    this.assertInside(canonicalRoot, canonicalTarget);
    return canonicalTarget;
  }

  private assertInside(root: string, target: string): void {
    const relative = path.relative(root, target);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return;
    throw new Error('Requested path is outside the active VS Code workspace.');
  }

  private async canonicalizePotentialPath(target: string): Promise<string> {
    try {
      return await fs.realpath(target);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(target);
      if (parent === target) throw error;
      const canonicalParent = await this.canonicalizePotentialPath(parent);
      return path.join(canonicalParent, path.basename(target));
    }
  }
}
