export interface ScratchGitRepo {
  dir: string;
  cleanup: () => void;
}

export function makeScratchGitRepo(options?: {
  prefix?: string;
  branch?: string;
  detached?: boolean;
}): ScratchGitRepo;
