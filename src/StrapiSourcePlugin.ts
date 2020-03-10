import crypto from 'crypto';
// import fs from 'fs';

import axios, { AxiosRequestConfig } from 'axios';
import pluralize from 'pluralize';
import { createRemoteFileNode } from 'gatsby-source-filesystem';
import createNodeHelpers from 'gatsby-node-helpers';

import /*type*/ { NodeInput, CreateSchemaCustomizationArgs, ParentSpanPluginArgs, GatsbyGraphQLType } from 'gatsby';
import /*type*/ { ComposeFieldConfigMap, ComposeFieldConfig } from 'graphql-compose';
import /*type*/ { GraphQLResolveInfo, GraphQLAbstractType } from 'graphql';
import /*type*/ * as Strapi from './strapi-types';

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
const DEFAULT_PAGE_SIZE = 100;
const TYPE_PREFIX = 'Strapi';

const { createNodeFactory } = createNodeHelpers({ typePrefix: TYPE_PREFIX });

// Node fields used internally by Gatsby.
const RESTRICTED_NODE_FIELDS = [
    `id`,
    `children`,
    `parent`,
    `fields`,
    `internal`,
];

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1);

const hashString = (data: string) => crypto
    .createHash(`md5`)
    .update(data)
    .digest(`hex`);

const hashData = (data: any) => hashString(JSON.stringify(data));

export default class StrapiSourcePlugin {

    private reporter = this.args.reporter;
    private cache = this.args.cache;

    private getNode = this.args.getNode as (id: string) => Node;
    private createNode = this.args.boundActionCreators.createNode;
    private touchNode = this.args.boundActionCreators.touchNode;

    private token?: string;
    private requestConfig?: AxiosRequestConfig;

    private gatsbyToStrapiType = new Map<string, string>();
    private strapiToGatsbyType = new Map<string, string>();

    private contentTypes!: Strapi.EntityType[];
    private contentTypeMap!: Map<string, Strapi.EntityType>;
    private componentTypeMap!: Map<string, Strapi.EntityType>;

    private graphqlTypes = new Map<string, GatsbyGraphQLType | undefined>();

    private apiURL: string;
    private pageSize: number;
    private loginData?: LoginData;
    private allowedTypes?: string[];
    private excludedTypes: string[];

    private initialized = false;

    constructor(
        private args: ParentSpanPluginArgs,
        options: StrapiPluginOptions,
    ) {
        this.apiURL = options.apiURL || DEFAULT_API_URL;
        this.pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
        this.loginData = options.loginData;
        this.allowedTypes = options.allowedTypes;
        this.excludedTypes = options.excludedTypes || ['user', 'role', 'permission'];
    }

    public getTypeName(type: Strapi.EntityType) {
        const node = createNodeFactory(type.apiID, n => n)({});
        return node.internal.type;
        // return TYPE_PREFIX + capitalize(type.apiID);
    }

    public async init() {
        // Handle authentication
        await this.login();

        // Fetch content types & components
        await this.fetchTypes();

        // Filter mapped types
        this.contentTypes = Array.from(this.contentTypeMap.values()).filter(x =>
            !this.excludedTypes.includes(x.apiID) &&
            (!this.allowedTypes || this.allowedTypes.includes(x.apiID))
        );

        this.initialized = true;
    }

    private async login() {
        if (!this.loginData)
            return;

        if (typeof this.loginData.identifier !== 'string' || this.loginData.identifier.length === 0)
            throw new StrapiSourceError('Empty identifier');

        if (typeof this.loginData.password !== 'string' || this.loginData.password.length === 0)
            throw new StrapiSourceError('Empty password');

        try {
            const loginResponse = await axios.post(`${this.apiURL}/auth/local`, this.loginData);

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
        if (!this.initialized)
            await this.init();
        try {
            const fetchActivity = this.reporter.activityTimer(`Fetched Strapi Data`);
            fetchActivity.start();
            try {
                await Promise.all(this.contentTypes.map(async (contentType) => {
                    // Fetch entities
                    const entities = await this.fetchEntities(contentType);

                    // Create node-creator
                    const fullTypeName = this.getTypeName(contentType);
                    this.gatsbyToStrapiType.set(fullTypeName, contentType.apiID);
                    this.strapiToGatsbyType.set(contentType.apiID, fullTypeName);

                    const nodeFactory = createNodeFactory(contentType.apiID, node => {
                        node.id = `${contentType.apiID}_${node.strapiId}`;
                        return node;
                    });

                    await Promise.all(entities.map(async (entity) => {
                        try {
                            const data = await this.mapEntityType(contentType, entity);

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
                return this.mapRichtext(attribute, key, data as string | null);
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

    private async mapRichtext(attribute: Strapi.RichtextAttribute, key: string, data: string | null): Promise<[string, unknown]> {
        if (typeof data !== 'string')
            return [`${key}___NODE`, undefined];

        const contentDigest = hashString(data);

        const markdownNode: NodeInput = {
            id: this.args.createNodeId(contentDigest),
            // parent: node.id,
            text: data,
            internal: {
                type: 'StrapiMarkdownString',
                mediaType: 'text/markdown',
                content: data,
                contentDigest,
            }
        };
        this.createNode(markdownNode);
        // this.createParentChildLink({ parent: node, child: fieldNode as Node });

        return [`${key}___NODE`, markdownNode.id];
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

            const type = this.componentTypeMap.get(typeName);
            if (!type)
                throw new StrapiSourceError(`Could not find component type ${typeName}`);

            // Transform component data
            const itemData = await this.mapEntityType(type, item);

            // Assign internal type discriminator to differentiate between types
            itemData.internal = { type: this.getTypeName(type) };
            itemData._type = this.getTypeName(type);

            return itemData;
        }));
        return [key, mappedItems];
    }

    private async mapComponent(attribute: Strapi.ComponentAttribute, key: string, data: unknown): Promise<[string, unknown]> {
        if (data === undefined || data === null)
            return [key, data];

        const type = this.componentTypeMap.get(attribute.component);
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

        const type = this.contentTypeMap.get(attribute.model);
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
            const url = `${media.url.startsWith('http') ? '' : this.apiURL}${media.url}`;
            const fileNode = await createRemoteFileNode({
                ...this.args,
                createNode: this.createNode,
                auth: this.token as any,
                url,
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
        const [contentTypes, components] = await Promise.all([
            this.fetch<{ data: Strapi.EntityType[]; }>('content-manager/content-types'),
            this.fetch<{ data: Strapi.EntityType[]; }>('content-manager/components'),
        ]);
        this.contentTypeMap = new Map(contentTypes.data.map(t => [t.apiID, t]));
        this.componentTypeMap = new Map(components.data.map(t => [t.uid, t]));
    }

    private async fetch<T>(path: string) {
        const url = `${this.apiURL}/${path}`;
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
            let index = 0;
            let result: StrapiEntity[] = [];
            while (true) {
                const query = `${endpoint}?_limit=${this.pageSize}&_start=${index}`;
                const response = await this.fetch<StrapiEntity[]>(query);
                result.push(...response);
                if (response.length < this.pageSize)
                    return result;
                index += this.pageSize;
            }
        }
    }

    public async createSchemaCustomization(args: CreateSchemaCustomizationArgs) {
        if (!this.initialized)
            await this.init();

        for (const ct of this.contentTypes) {
            this.defineType(ct);
        }

        const typeDefs = Array.from(this.graphqlTypes.values()).filter(Boolean).map(x => x!);

        // Add StrapiMarkdownString definition
        typeDefs.push(this.args.schema.buildObjectType({
            name: 'StrapiMarkdownString',
            interfaces: ['Node'],
            fields: {
                text: { type: 'String!' },
            },
        }));

        this.args.actions.createTypes(typeDefs);
    }

    private defineType(ct: Strapi.EntityType) {
        const fullTypeName = this.getTypeName(ct);
        if (this.graphqlTypes.has(fullTypeName))
            return this.graphqlTypes.get(fullTypeName);

        this.graphqlTypes.set(fullTypeName, undefined);

        const typeDef = this.args.schema.buildObjectType({
            name: fullTypeName,
            interfaces: ct.schema.modelType === 'contentType' ? ['Node'] : undefined,
            // extensions: { infer: false }, // Disable inference
            fields: this.mapEntityTypeToType(ct),
        });

        this.graphqlTypes.set(fullTypeName, typeDef);
        return typeDef;
    }

    private mapEntityTypeToType(type: Strapi.EntityType): ComposeFieldConfigMap<any, any> {
        return Object.fromEntries(
            Object.entries(type.schema.attributes)
                .map(([key, attribute]) => [key, this.mapAttributeToType(type, attribute, key)])
                .filter(x => x[1])
        );
    }

    private mapAttributeToType(type: Strapi.EntityType, attribute: Strapi.Attribute, key: string): ComposeFieldConfig<any, any> | undefined {
        const reqSuffix = attribute.required ? '!' : '';
        switch (attribute.type) {
            case 'string':
            case 'enumeration':
                return { type: 'String' + reqSuffix };
            case 'richtext':
                return { type: 'StrapiMarkdownString' + reqSuffix };
            case 'datetime':
            case 'timestamp':
                return { type: 'Date' + reqSuffix };
            case 'integer':
                return { type: 'Int' + reqSuffix };
            case 'media':
                return { type: 'File' + reqSuffix };
            case 'relation':
                return this.mapRelationToType(attribute, key);
            case 'component':
                return this.mapComponentToType(attribute, key);
            // case 'dynamiczone':
            //     return this.mapDynamicZoneToType(type, attribute, key);
        }
    }

    private mapRelationToType(attribute: Strapi.RelationAttribute, key: string): ComposeFieldConfig<any, any> | undefined {
        const type = this.contentTypeMap.get(attribute.model);
        if (!type) {
            console.warn(`Relation field ${key} type ${attribute.model} not found`);
            return;
        }
        this.defineType(type);
        const typeName = this.getTypeName(type);
        console.log(`Defining type for field ${key} as ` + typeName);
        return { type: typeName };
    }

    private mapComponentToType(attribute: Strapi.ComponentAttribute, key: string): ComposeFieldConfig<any, any> | undefined {
        const type = this.contentTypeMap.get(attribute.component);
        if (!type) {
            console.warn(`Component field ${key} type ${attribute.component} not found`);
            return;
        }
        this.defineType(type);
        const typeName = this.getTypeName(type);
        // console.log(`Defining type for field ${key} as ` + typeName);
        return { type: typeName };
    }

    private mapDynamicZoneToType(entityType: Strapi.EntityType, attribute: Strapi.DynamiczoneAttribute, key: string): ComposeFieldConfig<any, any> | undefined {
        const types = attribute.components
            .map(c => {
                const type = this.componentTypeMap.get(c);
                if (!type)
                    console.warn(`Dynamiczone field ${key} type ${c} not found`);
                return type!;
            })
            .filter(Boolean)
            .map(x => this.defineType(x!)!);

        // Build union type
        const unionTypeName = `StrapiUnion_${this.getTypeName(entityType)}_${key}`;
        const unionType = this.args.schema.buildUnionType({
            name: unionTypeName,
            types: types.map(x => x.config.name),
        });
        this.graphqlTypes.set(unionTypeName, unionType);

        // console.info(`Dynamiczone field ${key} using union type ${unionTypeName}`);
        return { type: `[${unionTypeName}!]!` };
    }

}

type GraphQlType = 'String' | 'Int' | 'Boolean' | 'File' | string;

interface GraphQlField {
    type: GraphQlType;
    args?: Record<string, GraphQlArg>;
    resolve?: (source: any, fieldArgs: Record<string, string | undefined>) => any;
}

interface GraphQlArg {
    type: GraphQlType;
}

class StrapiSourceError extends Error { }
