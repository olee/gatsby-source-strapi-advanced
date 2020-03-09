# @olee92/gatsby-source-strapi

[![npm version](https://badge.fury.io/js/%40olee92%2Fgatsby-source-strapi.svg)](https://badge.fury.io/js/%40olee92%2Fgatsby-source-strapi)

Source plugin for loading documents from Strapi API into gatsby.

The code has been originally inspired from https://github.com/strapi/gatsby-source-strapi

## How to use

There are two ways to configure access to Strapi API for this plugin:

1. Provide `identifier` and `password` fields in the configuration to allow the plugin to authenticate with Strapi API.
2. Allow public access to the following endpoints in Strapi:
    - `GET /content-manager/content-types`
    - `GET /content-manager/components`
    - The `find` endpoint on every content-type you would like to include, eg. `GET /articles`

If you allow public access, you do not have to add any options at all to get started.

Here are the full options with their default values (except loginData which is `undefined` by default):

```javascript
export default { plugins: [
    {
        resolve: '@olee92/gatsby-source-strapi',
        options: {
            apiURL: 'http://localhost:1337',
            pageSize: 100,
            excludedTypes: ['user', 'role', 'permission'];
            loginData: {
                identifier: "identifier",
                password: "password",
            },
        },
    }
]}
```

| **option**    | **defaultValue**                    | **type** | **description**                                                                                                                 |
|---------------|-------------------------------------|----------|---------------------------------------------------------------------------------------------------------------------------------|
| apiURL        | http://localhost:1337               | string   | URL to access Strapi API                                                                                                        |
| pageSize      | 100                                 | number   | The plugin will repeatedly fetch these many entries per query, until all entities have been loaded                              |
| allowedTypes  | undefined                           | string[] | If specified, only these content-types are sourced                                                                              |
| excludedTypes | `['user' , 'role' , 'permission' ]` | string[] | Exclude these content-types from all available content-types to source                                                          |
| loginData     | undefined                           | object   | Provide object with properties `identifier` and `password` to be able to access Strapi servers where authentication is required |

## How to query

You can query Document nodes created from your Strapi API like the following:

```graphql
query {
  allStrapiArticle {
    nodes {
        id
        title
        content
      }
    }
}
```

To query images you can do the following:

```graphql
query {
  allStrapiArticle {
    nodes {
      id
      singleImage {
        publicURL
      }
      multipleImages {
        localFile {
          publicURL
        }
      }
    }
  }
}
```
