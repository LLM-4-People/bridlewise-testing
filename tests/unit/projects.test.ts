// @vitest-environment node
import { describe, test, expect, beforeEach, afterEach } from "vitest";

import {
  projects,
  currentProjectId,
  currentProject,
  projectCount,
  setProjects,
  addProject,
  removeProject,
  selectProject,
  resetProjects,
} from "../../src/state/projects";

describe("projects store", () => {
  beforeEach(() => resetProjects());
  // The suite runs with isolate:false — without this, the LAST test's
  // populated store (p1 selected) leaks into whichever file runs next in
  // the worker (observed: sweep-spectrum-load's global-scope honesty test
  // seeing a phantom project scope).
  afterEach(() => resetProjects());

  test("setProjects populates the list and count", () => {
    setProjects([
      { id: "p1", name: "alpha", path: "/a", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
      { id: "p2", name: "beta", path: "/b", createdAt: "2026-01-02", updatedAt: "2026-01-02" },
    ]);
    expect(projects.get()).toHaveLength(2);
    expect(projectCount.get()).toBe(2);
  });

  test("addProject appends without mutating the previous array", () => {
    setProjects([{ id: "p1", name: "alpha", path: "/a", createdAt: "x", updatedAt: "x" }]);
    const before = projects.get();
    addProject({ id: "p2", name: "beta", path: "/b", createdAt: "y", updatedAt: "y" });
    expect(projects.get()).toHaveLength(2);
    expect(before).toHaveLength(1);
  });

  test("selectProject sets currentProjectId and currentProject resolves", () => {
    setProjects([{ id: "p1", name: "alpha", path: "/a", createdAt: "x", updatedAt: "x" }]);
    selectProject("p1");
    expect(currentProjectId.get()).toBe("p1");
    expect(currentProject.get()?.name).toBe("alpha");
  });

  test("currentProject is null when id does not match", () => {
    setProjects([{ id: "p1", name: "alpha", path: "/a", createdAt: "x", updatedAt: "x" }]);
    selectProject("nope");
    expect(currentProject.get()).toBeNull();
  });

  test("selectProject(null) clears selection", () => {
    setProjects([{ id: "p1", name: "alpha", path: "/a", createdAt: "x", updatedAt: "x" }]);
    selectProject("p1");
    selectProject(null);
    expect(currentProjectId.get()).toBeNull();
    expect(currentProject.get()).toBeNull();
  });

  test("removeProject removes the id and clears selection if active", () => {
    setProjects([
      { id: "p1", name: "alpha", path: "/a", createdAt: "x", updatedAt: "x" },
      { id: "p2", name: "beta", path: "/b", createdAt: "x", updatedAt: "x" },
    ]);
    selectProject("p1");
    removeProject("p1");
    expect(projects.get()).toHaveLength(1);
    expect(projects.get().some((p) => p.id === "p1")).toBe(false);
    expect(currentProjectId.get()).toBeNull();
  });

  test("removeProject does not mutate the previous array", () => {
    setProjects([{ id: "p1", name: "alpha", path: "/a", createdAt: "x", updatedAt: "x" }]);
    const before = projects.get();
    removeProject("nope");
    expect(before).toHaveLength(1);
    expect(projects.get()).toHaveLength(1);
  });
});
