/* eslint-disable spellcheck/spell-checker */
/* eslint-disable import/no-extraneous-dependencies */

import { initJSProjectWithProfile, deleteProject, createNewProjectDir, deleteProjectDir } from "@aws-amplify/amplify-e2e-core";
import { testSchema } from "../schema-api-directives";

describe("api directives @auth batch 6d", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createNewProjectDir("auth6");
    await initJSProjectWithProfile(projectDir, {});
  });

  afterEach(async () => {
    await deleteProject(projectDir);
    deleteProjectDir(projectDir);
  });

  it("auth subscriptions3", async () => {
    const testresult = await testSchema(projectDir, "auth", "subscriptions3");
    expect(testresult).toBeTruthy();
  });
});
