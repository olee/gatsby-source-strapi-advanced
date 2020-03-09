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
    pageSize?: number;
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
                        try {
                            const data = await this.mapEntityType(contentType, entity);

                            // await this.extractFields(data);
                            // const data = data;

                            // if (contentType.apiID === 'article' && data.id === 1) {
                            //     console.log(data);
                            // }
                            // if (contentType.apiID === 'page' && data.id === 1) {
                            //     console.log(data);
                            // }
                            // if (data.id === 1) {
                            //     console.log(data);
                            // }

                            // Create node
                            this.createNode(nodeFactory(data));
                        } catch (error) {
                            throw new StrapiSourceError(`Error mapping ${contentType.apiID} ${entity.id}: ${error}`);
                        }
                    }));
                }));

                // } catch (err) {
                //     console.error(err);
                //     throw err;
            } finally {
                fetchActivity.end();
                // process.exit();
            }
        } catch (error) {
            if (error instanceof StrapiSourceError) {
                this.reporter.panic('Strapi source error: ' + error.message);
                return;
            }
            throw error;
        }
    }

    private async mapEntityType(entityType: Strapi.EntityType, data: Record<string, unknown>) {
        const attributes = Object.entries(entityType.schema.attributes);
        const mappedFields = await Promise.all(
            attributes.map(async ([key, attribute]) => this.mapAttribute(attribute, key, data[key]))
        ).catch(err => {
            throw new StrapiSourceError(`Error mapping type ${entityType.apiID}: ${err}`);
        });
        try {
            return Object.fromEntries(mappedFields) as Record<string, unknown>;
        } catch (error) {
            console.log(mappedFields);
            process.exit();
        }
    }

    private async mapAttribute(attribute: Strapi.Attribute, key: string, data: unknown): Promise<[string, unknown]> {
        switch (attribute.type) {
            default:
            case 'string':
            case 'integer':
            case 'enumeration':
            case 'timestamp':
            case 'datetime':
                return [key, data];
            case 'richtext':
                return [key, data];
            case 'media':
                return await this.mapMedia(key, data as Strapi.Media);
            case 'relation':
                return await this.mapRelation(attribute, key, data);
            case 'component':
                return await this.mapComponent(attribute, key, data);
            case 'dynamiczone':
                return await this.mapDynamicZone(attribute, key, data);
        }
    }

    private async mapDynamicZone(attribute: Strapi.DynamiczoneAttribute, key: string, items: unknown): Promise<[string, unknown]> {
        if (items === undefined || items === null)
            return [key, items];
        if (!Array.isArray(items))
            throw new StrapiSourceError(`Expected array for field ${key}, but got ${typeof items}`);

        const mappedItems = await Promise.all(items.map(async item => {
            const typeName = item.__component;
            if (typeof typeName !== 'string')
                throw new StrapiSourceError(`Missing __component field`);

            const type = this.componentTypes.get(typeName);
            if (!type)
                throw new StrapiSourceError(`Could not find component type ${typeName}`);

            // Transform component data
            const itemData = await this.mapEntityType(type, item);

            // Attach component information
            itemData.$componentType = type.uid;
            itemData.$componentName = type.name;
            return itemData;
        }));
        return [key, mappedItems];
    }

    private async mapComponent(attribute: Strapi.ComponentAttribute, key: string, data: unknown): Promise<[string, unknown]> {
        if (data === undefined || data === null)
            return [key, data];

        const type = this.componentTypes.get(attribute.component);
        if (!type)
            throw new StrapiSourceError(`Could not find component type ${attribute.component}`);

        if (attribute.repeatable) {
            if (!Array.isArray(data))
                throw new StrapiSourceError(`Expected object for field ${key}, but got ${typeof data}`);

            return [key, await Promise.all(data.map(d => this.mapEntityType(type, d)))];
        } else {
            if (typeof data !== 'object')
                throw new StrapiSourceError(`Expected object for field ${key}, but got ${typeof data}`);

            return [key, await this.mapEntityType(type, data as any)];
        }
    }

    private async mapRelation(attribute: Strapi.RelationAttribute, key: string, data: unknown): Promise<[string, unknown]> {
        if (data === undefined || data === null)
            return [key, data];

        if (typeof data === 'number')
            return [key, data];

        if (typeof data !== 'object')
            throw new StrapiSourceError(`Expected object for field ${key}, but got ${typeof data}`);

        const type = this.contentTypes.get(attribute.model);
        if (!type)
            throw new StrapiSourceError(`Could not find relation type ${attribute.model}`);

        // TODO: We could potentially generate a real reference to another node here as `${key}___NODE`

        return [key, await this.mapEntityType(type, data as any)];
    }

    private async mapMedia(key: string, media: Strapi.Media | undefined): Promise<[string, unknown]> {
        if (!media || !media.url)
            return [`${key}___NODE`, undefined];

        // using field on the cache key for multiple image field
        const cacheKey = `strapi-media-${media.id}`; // -${key}
        const cacheData = await this.cache.get(cacheKey);

        if (cacheData && media.updated_at === cacheData.updated_at && this.getNode(cacheData.fileNodeID)) {
            this.touchNode({ nodeId: cacheData.fileNodeID });
            return [`${key}___NODE`, cacheData.fileNodeID];
        }

        try {
            // full media url
            const url = `${media.url.startsWith('http') ? '' : this.options.apiURL}${media.url}`;
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
                    updated_at: media.updated_at,
                });
                return [`${key}___NODE`, fileNode.id];
            }
        } catch (e) {
            console.error('Error creating file node for strapi media:', e);
        }
        return [key, media];
    }

    private async fetchTypes() {
        const contentTypes = await this.fetch<{ data: Strapi.EntityType[]; }>('content-manager/content-types');
        const componentTypes = await this.fetch<{ data: Strapi.EntityType[]; }>('content-manager/components');
        this.contentTypes = new Map(contentTypes.data.map(t => [t.apiID, t]));
        this.componentTypes = new Map(componentTypes.data.map(t => [t.uid, t]));
        return contentTypes.data;
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
            const pageSize = this.options.pageSize || DEFAULT_QUERY_LIMIT;
            let index = 0;
            let result: StrapiEntity[] = [];
            while (true) {
                const query = `${endpoint}?_limit=${pageSize}&_start=${index}`;
                const response = await this.fetch<StrapiEntity[]>(query);
                result.push(...response);
                if (response.length < pageSize)
                    return result;
                index += pageSize;
            }
        }
    }

}

class StrapiSourceError extends Error { }
