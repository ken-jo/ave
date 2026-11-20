import { BaseSequencer, type TestSpecification } from "vitest/node";

function isExhaustiveBoundary(file: TestSpecification): boolean {
  return file.moduleId.replaceAll("\\", "/").includes("/src/permissions/__tests__/powershell-encoded-unicode/");
}

/** Keep exhaustive partitions balanced and start them while other workers can make progress. */
export default class BoundarySequencer extends BaseSequencer {
  protected includeOrder(_file: TestSpecification): number {
    return 0;
  }

  async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const partitions = files.filter(isExhaustiveBoundary).sort((a, b) =>
      a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : a.project.name.localeCompare(b.project.name));
    const ordinary = await super.shard(files.filter(file => !isExhaustiveBoundary(file)));
    return [...ordinary, ...partitions.filter((_, index) => index % shard.count === shard.index - 1)];
  }

  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const ordered = await super.sort(files);
    const ordinal = new Map(ordered.map((file, index) => [file, index]));
    return ordered.sort((a, b) =>
      (a.project.config.sequence.groupOrder ?? 0) - (b.project.config.sequence.groupOrder ?? 0)
      || this.includeOrder(a) - this.includeOrder(b)
      || Number(isExhaustiveBoundary(b)) - Number(isExhaustiveBoundary(a))
      || ordinal.get(a)! - ordinal.get(b)!);
  }
}

export class PermissionStepSequencer extends BoundarySequencer {
  protected override includeOrder(file: TestSpecification): number {
    if (file.project.name !== "permission-timing") return 0;
    const moduleId = file.moduleId.replaceAll("\\", "/");
    return file.project.config.include.findIndex(path => moduleId.endsWith(`/${path}`));
  }
}
