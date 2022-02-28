const core = require("@actions/core");
const github = require("@actions/github");
const { graphql } = require("@octokit/graphql");

const accessToken = core.getInput("access-token");

const columnIdQuery = `query columns($owner: String!, $name: String!, $projectName: String!) {
  repository(owner: $owner, name: $name) {
    projects(search: $projectName, last: 1) {
      edges {
        node {
          columns(first: 20) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    }
  }
}`;

const cardIdsForIssue = `query issues($issueId: ID!) {
  node(id: $issueId) {
    ... on Issue {
      projectCards(first: 5) {
        edges {
          node {
            id
          }
        }
      }
    }
  }
}`;

(async function () {
  try {
    // Set input constants
    const inputIssues = core.getInput("issues");
    const parsedInput = JSON.parse(inputIssues);
    const project = core.getInput("project-name");
    const columnName = core.getInput("target-column");
    const columnId = core.getInput("target-column-id");

    const payload =
      parsedInput.length !== 0 ? parsedInput : github.context.payload;
    core.info(`JSON.stringify(payload): ${JSON.stringify(payload, null, 2)}`);

    const issues = Array.isArray(payload) ? payload : [payload];
    const issueSample = issues[0].issue;

    // Early return if a member of payload doesn't respond to `issue`
    if (typeof issueSample === "undefined") {
      core.info("No issues to move");
      return;
    }

    const repoUrl = issueSample.repository_url;
    const splitUrl = repoUrl.split("/");
    const repoOwner = splitUrl[4];
    const repo = splitUrl[5];

    // Find target column
    const edges = await getColumnIds(repoOwner, repo, project);
    const columns = edges
      .flatMap((p) => p.node.columns.edges)
      .map((c) => c.node);

    const targetColumn =
      typeof columnId !== "undefined"
        ? columns.find((c) => c.id === columnId)
        : columns.find((c) => {
            core.info(
              `column.name (${JSON.stringify(c.name)}) ` +
                `=== columnName (${JSON.stringify(columnName)}): ` +
                `${JSON.stringify(
                  c.name.toLowerCase() === columnName.toLowerCase()
                )}`
            );

            return c.name.toLowerCase() === columnName.toLowerCase();
          });

    core.info(`Column name: ${columnName.toLowerCase()}`);
    core.info(`Column id: ${columnId}`);
    core.info(`Searching columns: ${JSON.stringify(columns, null, 2)}`);
    core.info(`targetColumn: ${JSON.stringify(targetColumn, null, 2)}`);

    // Find card ids for issues
    const issueIds = issues.map((i) => i.issue.node_id);
    const cardPromises = await Promise.all(issueIds.map(getCardsForIssue));
    const cardNodes = cardPromises.flatMap((c) => c.node);
    // Filter nodes before proceeding in case the issue does not have card associated.
    const cardIds = cardNodes
      .filter((node) => node.projectCards != null)
      .flatMap((filtered) => filtered.projectCards.edges)
      .flatMap((e) => e.node.id);

    // Update cards only if the column exists
    if (typeof targetColumn === "undefined") {
      core.setFailed(
        "Target column does not exist on project. Please use a different column name"
      );
      return;
    }

    const targetColumnId = targetColumn.id;

    core.info(
      `Moving ${cardIds.length} cards to ${columnName} (node_id: ${targetColumnId}) in project ${project}`
    );

    cardIds.forEach((cardId) => {
      moveCardToColumn(cardId, targetColumnId);
      core.info(`Moving cardId: ${cardId}`);
    });
  } catch (error) {
    core.setFailed(error.message);
  }
})();

async function getColumnIds(owner, repo, projectName) {
  const { repository } = await graphql(columnIdQuery, {
    owner: owner,
    name: repo,
    projectName: projectName,
    headers: {
      authorization: `bearer ${accessToken}`,
    },
  });

  return repository.projects.edges;
}

async function getCardsForIssue(issueId) {
  return graphql(cardIdsForIssue, {
    issueId: issueId,
    headers: {
      authorization: `bearer ${accessToken}`,
    },
  });
}

const updateCardColumnMutation = `mutation updateProjectCard($cardId: ID!, $columnId: ID!) {
  moveProjectCard(input:{cardId: $cardId, columnId: $columnId}) {
    clientMutationId
  }
}`;

async function moveCardToColumn(cardId, columnId) {
  return graphql(updateCardColumnMutation, {
    cardId: cardId,
    columnId: columnId,
    headers: {
      authorization: `bearer ${accessToken}`,
    },
  });
}
