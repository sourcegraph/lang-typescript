import gql from 'tagged-template-noop'

export interface SourcegraphInstanceOptions {
    instanceUrl: URL
    accessToken?: string
}

/**
 * Does a GraphQL request to the Sourcegraph GraphQL API
 *
 * @param query The GraphQL request (query or mutation)
 * @param variables A key/value object with variable values
 */
export async function requestGraphQL(
    query: string,
    variables: any = {},
    { instanceUrl, accessToken }: SourcegraphInstanceOptions
): Promise<{ data?: any; errors?: { message: string; path: string }[] }> {
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
    }
    if (accessToken) {
        headers.Authorization = 'token ' + accessToken
    }
    const response = await fetch(new URL('/.api/graphql', instanceUrl).href, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
    })
    if (!response.ok) {
        throw new Error(response.statusText)
    }
    return await response.json()
}

export async function search(query: string, sgInstanceOptions: SourcegraphInstanceOptions): Promise<any> {
    const { data, errors } = await requestGraphQL(
        gql`
            query Search($query: String!) {
                search(query: $query) {
                    results {
                        results {
                            ... on FileMatch {
                                repository {
                                    name
                                }
                            }
                        }
                    }
                }
            }
        `,
        { query },
        sgInstanceOptions
    )
    if (errors && errors.length > 0) {
        throw new Error('GraphQL Error:' + errors.map(e => e.message).join('\n'))
    }
    return data.search.results.results
}

/**
 * @param rev A revision (branch name, tag, "HEAD", ...)
 * @returns The commit ID of the given revision
 */
export async function resolveRev(
    repoName: string,
    rev: string,
    sgInstanceOptions: SourcegraphInstanceOptions
): Promise<string> {
    const { data, errors } = await requestGraphQL(
        gql`
            query ResolveRev($repoName: String!, $rev: String!) {
                repository(name: $repoName) {
                    commit(rev: $rev) {
                        oid
                    }
                }
            }
        `,
        { repoName, rev },
        sgInstanceOptions
    )
    if (errors && errors.length > 0) {
        throw new Error('GraphQL Error:' + errors.map(e => e.message).join('\n'))
    }
    return data.repository.commit.oid
}

/**
 * Uses the Sourcegraph GraphQL API to resolve a git clone URL to a Sourcegraph repository name.
 *
 * @param cloneUrl A git clone URL
 * @return The Sourcegraph repository name (can be used to construct raw API URLs)
 */
export async function resolveRepository(cloneUrl: string, options: SourcegraphInstanceOptions): Promise<string> {
    const { data, errors } = await requestGraphQL(
        gql`
            query($cloneUrl: String!) {
                repository(cloneURL: $cloneUrl) {
                    name
                }
            }
        `,
        { cloneUrl },
        options
    )
    if (errors && errors.length > 0) {
        throw new Error('GraphQL Error:' + errors.map(e => e.message).join('\n'))
    }
    if (!data.repository) {
        throw new Error(`No repository found for clone URL ${cloneUrl} on instance ${options.instanceUrl}`)
    }
    return data.repository.name
}
