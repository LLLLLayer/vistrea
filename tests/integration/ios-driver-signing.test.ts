import assert from "node:assert/strict";
import { test } from "node:test";

import { developmentTeamsFromIdentitySubjects } from "../../integrations/cli/ios-driver.js";

test("iOS driver reads the Apple Team ID from the matching certificate OU", () => {
  const identities = [
    '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: Created via API (Y9H84B2UMR)"',
    '  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "Developer ID Application: Example Company (WRONGTEAM1)"',
    "     2 valid identities found",
  ].join("\n");
  const subjects = [
    [
      "C=US",
      "O=Example Company",
      "OU=Q2T8TN4ZW6",
      "CN=Apple Development: Created via API (Y9H84B2UMR)",
      "UID=Y9H84B2UMR",
    ].join("\n"),
    [
      "C=US",
      "O=Other Company",
      "OU=NOTSELECT1",
      "CN=Apple Development: Other User (OTHERUID01)",
      "UID=OTHERUID01",
    ].join("\n"),
  ];

  assert.deepEqual(developmentTeamsFromIdentitySubjects(identities, subjects), ["Q2T8TN4ZW6"]);
});

test("iOS driver ignores non-development and certificate-only teams", () => {
  const identities = [
    '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: First User (FIRSTUID01)"',
    '  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "iPhone Developer: Second User (SECONDUID1)"',
    '  3) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "Developer ID Application: Mac User (MACUSER001)"',
  ].join("\n");
  const subjects = [
    "OU=TEAM000002\nCN=iPhone Developer: Second User (SECONDUID1)",
    "OU=TEAM000001\nCN=Apple Development: First User (FIRSTUID01)",
    "OU=TEAM000003\nCN=Apple Development: No Private Key (NOPRIVATE1)",
    "OU=MACOS00001\nCN=Developer ID Application: Mac User (MACUSER001)",
  ];

  assert.deepEqual(developmentTeamsFromIdentitySubjects(identities, subjects), [
    "TEAM000001",
    "TEAM000002",
  ]);
});
