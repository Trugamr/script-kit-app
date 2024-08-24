/* eslint-disable */
import '@johnlindquist/kit';

const { stdout: branchName } = await exec('git rev-parse --abbrev-ref HEAD');

let kitTag = 'next';
if (branchName.trim() === 'main') {
  kitTag = 'latest';
}

try {
  core.setOutput('kit_tag', kitTag);
  core.exportVariable('kit_tag', kitTag);

  console.log(`kit_tag set to: ${kitTag}`);
} catch (error) {
  console.error(error);
}
