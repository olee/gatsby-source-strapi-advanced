
export interface EntityType {
    uid: string;
    name: string;
    apiID: string;
    label: string;
    isDisplayed: boolean;
    schema: Schema;
    category: string;
}

export interface Schema {
    kind: 'collectionType' | 'singleType';
    modelType: 'contentType' | 'component';
    collectionName: string;
    info: SchemaInfo;
    options: SchemaOptions;
    attributes: Record<string, Attribute>;
    connection: string; // 'default'
}

export interface SchemaInfo {
    name: string;
    icon?: string;
    description?: string;
}

export interface SchemaOptions {
    increments?: boolean;
    timestamps?: string[] | false;
}

export type AttributeType = Attribute['type'];

export type Attribute =
    StringAttribute |
    RichtextAttribute |
    IntegerAttribute |
    TimestampAttribute |
    DatetimeAttribute |
    EnumerationAttribute |
    MediaAttribute |
    RelationAttribute |
    ComponentAttribute |
    DynamiczoneAttribute;

interface AttributeBase<TValue = unknown> {
    type: AttributeType;
    required?: boolean;
    unique?: boolean;
    configurable?: boolean;
}

interface StringBaseAttribute extends AttributeBase<string> {
    default?: string;
    maxLength?: number;
    minLength?: number;
}

export interface StringAttribute extends StringBaseAttribute {
    type: 'string';
}

export interface RichtextAttribute extends StringBaseAttribute {
    type: 'richtext';
}

export interface IntegerAttribute extends AttributeBase<number> {
    type: 'integer';
    default?: number;
}

export interface TimestampAttribute extends AttributeBase<string> {
    type: 'timestamp';
    default?: string;
}

export interface DatetimeAttribute extends AttributeBase<string> {
    type: 'datetime';
    default?: string;
}

export interface EnumerationAttribute extends AttributeBase<string[]> {
    type: 'enumeration';
    default?: string;
    enum: string[];
}

export interface MediaAttribute extends AttributeBase<Media> {
    type: 'media';
    multiple: boolean;
}

export interface RelationAttribute extends AttributeBase {
    type: 'relation';
    relationType: 'oneWay' | 'oneToOne' | 'oneToMany' | 'manyToOne' | 'manyToMany' | 'manyWay';
    model: string;
    targetModel: string;
    /** relation property name */
    via?: string;
    collection?: string;
    isVirtual?: boolean;
    plugin?: string;
}

export interface ComponentAttribute extends AttributeBase {
    type: 'component';
    repeatable: boolean;
    component: string;
}

export interface DynamiczoneAttribute extends AttributeBase {
    type: 'dynamiczone';
    repeatable: boolean;
    components: string[];
    min?: number;
    max?: number;
}

export interface Media {
    id: number;
    name: string;
    hash: string;
    sha256: string;
    ext: string;
    mime: string;
    size: number;
    url: string;
    provider: string;
    provider_metadata: null;
    created_at: string;
    updated_at: string;
}

