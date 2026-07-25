// TypeSpec real-world example — a hand-authored reconstruction of the shape
// of the GitHub REST API's repositories and issues surface. No third-party
// text copied; resource names and field shapes follow the public API only.
import "@typespec/http";
import "@typespec/rest";

using TypeSpec.Http;
using TypeSpec.Rest;

@service(#{ title: "GitHub-style Repos API" })
namespace GitHubStyle;

/// Issue lifecycle state.
enum IssueState {
  open,
  closed,
}

/// The account that owns a repository.
model Owner {
  login: string;
  ownerId: int64;
  siteAdmin: boolean;
}

/// A source-code repository.
model Repository {
  @key fullName: string;
  name: string;
  owner: Owner;
  description?: string;
  private: boolean;
  defaultBranch: string;
  stargazersCount: int64;
  openIssuesCount: int64;
}

/// Payload to create a repository.
model NewRepository {
  name: string;
  description?: string;
  private?: boolean;
}

/// An issue on a repository.
model Issue {
  @key issueNumber: int64;
  title: string;
  body?: string;
  state: IssueState;
  labels: string[];
  createdAt: utcDateTime;
}

/// Payload to open a new issue.
model NewIssue {
  title: string;
  body?: string;
  labels?: string[];
}

@route("/user/repos")
interface UserRepos {
  /// List repositories for the authenticated user.
  @get list(@query visibility: string): Repository[];

  /// Create a repository for the authenticated user.
  @post create(@body repo: NewRepository): Repository;
}

@route("/repos")
interface Issues {
  /// List issues for a repository.
  @get list(@path fullName: string, @query state: string): Issue[];

  /// Open a new issue on a repository.
  @post create(@path fullName: string, @body issue: NewIssue): Issue;
}
