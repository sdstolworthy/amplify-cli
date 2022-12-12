import fs from "fs-extra";
const ReadMeContent = `# Getting Started with Amplify CLI
This directory was generated by [Amplify CLI](https://docs.amplify.aws/cli).

Helpful resources:
- Amplify documentation: https://docs.amplify.aws
- Amplify CLI documentation: https://docs.amplify.aws/cli
- More details on this folder & generated files: https://docs.amplify.aws/cli/reference/files
- Join Amplify's community: https://amplify.aws/community/
`;

export function writeReadMeFile(readMeFilePath: string): void {
  fs.writeFileSync(readMeFilePath, ReadMeContent);
}
