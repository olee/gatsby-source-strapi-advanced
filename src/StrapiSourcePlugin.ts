import axios, { AxiosRequestConfig } from 'axios';
import { SourceNodesArgs, NodeInput } from 'gatsby';
import pluralize from 'pluralize';
import { createRemoteFileNode } from 'gatsby-source-filesystem';
import createNodeHelpers from 'gatsby-node-helpers';

import * as Strapi from './strapi-types';

export interface LoginData {
    identifier: string;
    password: string;
}

export interface StrapiPluginOptions {
    apiURL?: string;
    allowedTypes?: string[];
    excludedTypes?: string[];
    loginData?: LoginData;
    queryLimit?: number;
    plugins?: unknown[];
}

interface StrapiEntity {
    id: number;
    [k: string]: unknown;
}

const DEFAULT_API_URL = 'http://localhost:1337';
const DEFAULT_QUERY_LIMIT = 100;

const { createNodeFactory } = createNodeHelpers({
    typePrefix: 'Strapi',
});

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

export default class StrapiSourcePlugin {

    private reporter = this.sourceArgs.reporter;
    private cache = this.sourceArgs.cache;
    private store = this.sourceArgs.store;

    private createNode = this.sourceArgs.boundActionCreators.createNode;
    private touchNode = this.sourceArgs.boundActionCreators.touchNode;
    private getNode = this.sourceArgs.getNode as (id: string) => Node;

    private token?: string;
    private requestConfig?: AxiosRequestConfig;

    private contentTypes!: Map<string, Strapi.EntityType>;
    private componentTypes!: Map<string, Strapi.EntityType>;

    constructor(
        private sourceArgs: SourceNodesArgs,
        private options: StrapiPluginOptions,
    ) {
    }

    private async login() {
        if (!this.options.loginData)
            return;

        if (typeof this.options.loginData.identifier !== 'string' || this.options.loginData.identifier.length === 0)
            throw new StrapiSourceError('Empty identifier');

        if (typeof this.options.loginData.password !== 'string' || this.options.loginData.password.length === 0)
            throw new StrapiSourceError('Empty password');

        try {
            const loginResponse = await axios.post(`${this.options.apiURL}/auth/local`, this.options.loginData);

            if (typeof loginResponse.data?.jwt !== 'string')
                throw new StrapiSourceError('Invalid response: ' + JSON.stringify(loginResponse.data));

            this.token = loginResponse.data.jwt;
            this.requestConfig = {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                }
            };
        } catch (e) {
            throw new StrapiSourceError('Auth request error: ' + e);
        }
    }

    public async sourceNodes() {
        try {
            // Handle authentication
            await this.login();

            const fetchActivity = this.reporter.activityTimer(`Fetched Strapi Data`);
            fetchActivity.start();
            try {
                // Fetch content types & components
                const contentTypes = await this.fetchTypes();

                const allowedTypes = this.options.allowedTypes;
                const excludedTypes = this.options.excludedTypes || ['user', 'role', 'permission'];

                const filteredTypes = contentTypes.filter(x =>
                    !excludedTypes.includes(x.apiID) &&
                    (!allowedTypes || allowedTypes.includes(x.apiID))
                );

                // Fetch entities
                // await Promise.all(filteredTypes.map(async (contentType) => {
                //     const entities = await this.fetchEntities(contentType);

                //     await Promise.all(entities.map(e => this.extractFields(e)));

                //     if (contentType.apiID === 'article') {
                //         console.log(entities[0]);
                //     }

                //     // download media files
                //     // for (const entity of entities) {
                //     //     this.processData(contentType, entity);
                //     // }

                //     const typeName = contentType.apiID[0].toUpperCase() + contentType.apiID.slice(1);
                //     const Node = createNodeFactory(typeName, node => {
                //         node.id = `${typeName}_${node.strapiId}`;
                //         return node;
                //     });
                //     for (const entity of entities) {
                //         const node = Node(entity);
                //         this.createNode(node);
                //     }
                // }));

                await Promise.all(filteredTypes.map(async (contentType) => {
                    // Fetch entities
                    const entities = await this.fetchEntities(contentType);

                    // Create node-creator
                    const typeName = capitalize(contentType.apiID);
                    const nodeFactory = createNodeFactory(typeName, node => {
                        node.id = `${typeName}_${node.strapiId}`;
                        return node;
                    });

                    await Promise.all(entities.map(async (entity) => {
                        await this.extractFields(entity);

                        // if (contentType.apiID === 'article' && entity.id === 1) {
                        //     console.log(entity);
                        // }

                        // Create node
                        this.createNode(nodeFactory(entity));
                    }));
                }));

            } finally {
                fetchActivity.end();
            }
        } catch (error) {
            if (error instanceof StrapiSourceError) {
                this.reporter.panic('Strapi source error: ' + error.message);
                return;
            }
            throw error;
        }
    }

    private processData(entityType: Strapi.EntityType, entity: StrapiEntity) {
        const nodeData: Record<string, any> = {
        };
        for (const attribute of entityType.schema.attributes) {
            switch (attribute.type) {
                default:
                case 'string':
                case 'integer':
                case 'enumeration':
                case 'timestamp':
                case 'datetime':
                    break;
                case 'richtext':
                    break;
                case 'media':
                    break;
                case 'relation':
                    break;
                case 'component':
                    break;
                case 'dynamiczone':
                    break;
            }
        }
    }

    private async fetchTypes() {
        const contentTypes = await this.fetch<{ data: Strapi.EntityType[]; }>('content-manager/content-types');
        const componentTypes = await this.fetch<{ data: Strapi.EntityType[]; }>('content-manager/components');
        this.contentTypes = new Map(contentTypes.data.map(t => [t.apiID, t]));
        this.componentTypes = new Map(componentTypes.data.map(t => [t.apiID, t]));
        return contentTypes.data;
    }

    private async extractFields(item: any, key = 'localFile') {
        // image fields have a mime property among other
        // maybe should find a better test
        if (item && item.hasOwnProperty('mime')) {
            // console.log('Found image', item);

            // If we have cached media data and it wasn't modified, reuse previously created file node to not try to re-download
            let fileNodeID = await this.getOrCreateFileNode(item);

            if (fileNodeID) {
                if (key !== 'localFile') {
                    return fileNodeID;
                }
                item.localFile___NODE = fileNodeID;
            }
        } else if (Array.isArray(item)) {
            await Promise.all(item.map(f => this.extractFields(f)));
        } else if (item && typeof item === 'object') {
            for (const key of Object.keys(item)) {
                const field = item[key];

                const fileNodeID = await this.extractFields(field, key);

                if (fileNodeID) {
                    delete item[key];
                    item[`${key}___NODE`] = fileNodeID;
                }
            }
        }
    }

    private async getOrCreateFileNode(item: any) {
        // using field on the cache key for multiple image field
        const cacheKey = `strapi-media-${item.id}`; // -${key}
        const cacheData = await this.cache.get(cacheKey);

        if (cacheData && item.updatedAt === cacheData.updatedAt && this.getNode(cacheData.fileNodeID)) {
            this.touchNode({ nodeId: cacheData.fileNodeID });
            return cacheData.fileNodeID;
        }

        try {
            // full media url
            const url = `${item.url.startsWith('http') ? '' : this.options.apiURL}${item.url}`;
            const fileNode = await createRemoteFileNode({
                ...this.sourceArgs,
                createNode: this.createNode,
                auth: this.token as any,
                url,
                // store: this.sourceArgs.store,
                // cache: this.sourceArgs.cache,
                // createNodeId: this.sourceArgs.createNodeId,
                // reporter: this.sourceArgs.reporter,
            });
            // If we don't have cached data, download the file
            if (fileNode) {
                await this.cache.set(cacheKey, {
                    fileNodeID: fileNode.id,
                    updatedAt: item.updatedAt,
                });
                return fileNode.id;
            }
        } catch (e) {
            console.error('Error creating file node for strapi media:', e);
        }
    }

    private async fetch<T>(path: string) {
        const apiURL = this.options.apiURL || DEFAULT_API_URL;
        const url = `${apiURL}/${path}`;
        this.reporter.info(`Strapi get: ${path}`);
        try {
            const documents = await axios.get<T>(url, this.requestConfig);
            return documents.data;
        } catch (error) {
            throw new StrapiSourceError(`Failed to query ${path}: ` + error);
        }
    }

    private async fetchEntities(contentType: Strapi.EntityType) {
        if (contentType.schema.kind === 'singleType') {
            return [
                await this.fetch<StrapiEntity>(contentType.apiID)
            ];
        }
        else {
            const endpoint = pluralize(contentType.apiID);
            const queryLimit = this.options.queryLimit || DEFAULT_QUERY_LIMIT;
            let index = 0;
            let result: StrapiEntity[] = [];
            while (true) {
                const query = `${endpoint}?_limit=${queryLimit}&_start=${index}`;
                const response = await this.fetch<StrapiEntity[]>(query);
                result.push(...response);
                if (response.length < queryLimit)
                    return result;
                index += queryLimit;
            }
        }
    }

    // private clean(item: StrapiEntity[]) {
    //     item.forEach((value, key) => {
    //         if (startsWith(key, `__`)) {
    //             delete item[key];
    //         } else if (startsWith(key, `_`)) {
    //             delete item[key];
    //             item[key.slice(1)] = value;
    //         } else if (isObject(value)) {
    //             item[key] = clean(value);
    //         }
    //     });
    // }
}

class StrapiSourceError extends Error { }
