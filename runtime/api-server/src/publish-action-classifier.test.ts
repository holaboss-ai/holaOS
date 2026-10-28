import assert from "node:assert/strict";
import test from "node:test";

import { classifyPublishAction } from "./publish-action-classifier.js";

const GATED: Array<[string, string]> = [
  ["twitter", "TWITTER_CREATION_OF_A_POST"],
  ["twitter", "TWITTER_SEND_A_NEW_MESSAGE_TO_A_DM_CONVERSATION"],
  ["twitter", "TWITTER_CREATE_A_NEW_DM_CONVERSATION"],
  ["twitter", "TWITTER_UPLOAD_MEDIA"],
  ["twitter", "TWITTER_CAUSES_THE_USER_IN_THE_PATH_TO_RETWEET_SPECIFIED_POST"],
  ["linkedin", "LINKEDIN_CREATE_LINKED_IN_POST"],
  ["linkedin", "LINKEDIN_CREATE_COMMENT_ON_POST"],
  ["reddit", "REDDIT_CREATE_REDDIT_POST"],
  ["reddit", "REDDIT_POST_REDDIT_COMMENT"],
  ["reddit", "REDDIT_EDIT_REDDIT_COMMENT_OR_POST"],
  ["facebook", "FACEBOOK_CREATE_POST"],
  ["facebook", "FACEBOOK_SEND_MESSAGE"],
  ["facebook", "FACEBOOK_SCHEDULE_POST"],
  ["instagram", "INSTAGRAM_CREATE_MEDIA_CONTAINER"],
  ["instagram", "INSTAGRAM_PUBLISH_MEDIA"],
  ["instagram", "INSTAGRAM_REPLY_TO_COMMENT"],
  ["threads", "THREADS_CREATE_THREADS_POST"],
  ["tiktok", "TIKTOK_POST_VIDEO"],
  ["youtube", "YOUTUBE_UPLOAD_VIDEO"],
  ["youtube", "YOUTUBE_UPDATE_VIDEO"],
  ["pinterest", "PINTEREST_CREATE_PIN"],
  ["bluesky", "BLUESKY_CREATE_POST"],
  ["mastodon", "MASTODON_POST_STATUS"],
  ["linkedin", "LINKEDIN_PUBLISH_DRAFT"],
];

const NOT_GATED: Array<[string, string]> = [
  ["twitter", "TWITTER_POST_LOOKUP_BY_POST_ID"],
  ["twitter", "TWITTER_POST_DELETE_BY_POST_ID"],
  ["twitter", "TWITTER_RECENT_SEARCH"],
  ["twitter", "TWITTER_USER_LOOKUP_ME"],
  ["twitter", "TWITTER_RETRIEVE_POSTS_THAT_QUOTE_A_POST"],
  ["twitter", "TWITTER_GET_POST_RETWEETERS_ACTION"],
  ["twitter", "TWITTER_CAUSES_THE_USER_IN_THE_PATH_TO_LIKE_THE_SPECIFIED_POST"],
  ["twitter", "TWITTER_HIDE_REPLIES"],
  ["linkedin", "LINKEDIN_GET_MY_INFO"],
  ["linkedin", "LINKEDIN_DELETE_LINKED_IN_POST"],
  ["linkedin", "LINKEDIN_CREATE_DRAFT_POST"],
  ["reddit", "REDDIT_RETRIEVE_POST_COMMENTS"],
  ["reddit", "REDDIT_SEARCH_ACROSS_SUBREDDITS"],
  ["reddit", "REDDIT_DELETE_REDDIT_COMMENT"],
  ["facebook", "FACEBOOK_GET_PAGE_POSTS"],
  ["facebook", "FACEBOOK_LIKE_POST"],
  ["instagram", "INSTAGRAM_GET_USER_MEDIA"],
  ["youtube", "YOUTUBE_LIST_COMMENT_THREADS"],
  ["youtube", "YOUTUBE_SEARCH_YOU_TUBE"],
  ["youtube", "YOUTUBE_SUBSCRIBE_CHANNEL"],
  ["gmail", "GMAIL_SEND_EMAIL"],
  ["slack", "SLACK_SEND_MESSAGE"],
  ["notion", "NOTION_CREATE_NOTION_PAGE"],
  ["github", "GITHUB_CREATE_AN_ISSUE"],
];

test("classifyPublishAction gates publishing actions on social toolkits", () => {
  for (const [toolkitSlug, toolSlug] of GATED) {
    assert.notEqual(
      classifyPublishAction({ toolkitSlug, toolSlug }),
      null,
      `${toolSlug} should be gated`,
    );
  }
});

test("classifyPublishAction leaves reads, deletes, drafts and non-social toolkits alone", () => {
  for (const [toolkitSlug, toolSlug] of NOT_GATED) {
    assert.equal(
      classifyPublishAction({ toolkitSlug, toolSlug }),
      null,
      `${toolSlug} should not be gated`,
    );
  }
});

test("classifyPublishAction keys on the tool slug prefix even when the toolkit slug disagrees", () => {
  assert.notEqual(
    classifyPublishAction({ toolkitSlug: "gmail", toolSlug: "TWITTER_CREATION_OF_A_POST" }),
    null,
  );
  assert.notEqual(
    classifyPublishAction({ toolkitSlug: "twitter", toolSlug: "creation_of_a_post" }),
    null,
  );
  assert.notEqual(
    classifyPublishAction({ toolkitSlug: "", toolSlug: "linkedin_create_linked_in_post" }),
    null,
  );
});

test("classifyPublishAction describes the platform and action", () => {
  assert.deepEqual(
    classifyPublishAction({ toolkitSlug: "twitter", toolSlug: "twitter_creation_of_a_post" }),
    {
      platform: "twitter",
      platformLabel: "X",
      toolSlug: "TWITTER_CREATION_OF_A_POST",
      actionLabel: "Creation of a post",
    },
  );
  assert.equal(
    classifyPublishAction({ toolkitSlug: "linkedin", toolSlug: "LINKEDIN_CREATE_LINKED_IN_POST" })
      ?.platformLabel,
    "LinkedIn",
  );
});
