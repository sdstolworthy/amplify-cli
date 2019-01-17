import * as fs from 'fs';
import * as path from 'path';
import { CloudFormation, Fn } from "cloudform-types";
import GraphQLTransform from '..';
import DeploymentResources from '../DeploymentResources';
import { ResourceConstants } from 'graphql-transformer-common';

export interface ProjectOptions {
    projectDirectory: string
    transform: GraphQLTransform
    rootStackFileName?: string
}

export async function buildProject(opts: ProjectOptions) {
    const userProjectConfig = await readProjectConfiguration(opts.projectDirectory)
    const transformOutput = opts.transform.transform(userProjectConfig.schema.toString())
    const merged = mergeUserConfigWithTransformOutput(userProjectConfig, transformOutput)
    writeDeploymentToDisk(merged, path.join(opts.projectDirectory, 'build'), opts.rootStackFileName)
}

/**
 * Merge user config on top of transform output when needed.
 */
function mergeUserConfigWithTransformOutput(
    userConfig: Partial<DeploymentResources>,
    transformOutput: DeploymentResources
) {
    // Override user defined resolvers.
    const userResolvers = userConfig.resolvers || {};
    const transformResolvers = transformOutput.resolvers;
    for (const userResolver of Object.keys(userResolvers)) {
        transformResolvers[userResolver] = userConfig.resolvers[userResolver]
    }

    // Override user defined stacks.
    const userStacks = userConfig.stacks || {};
    const transformStacks = transformOutput.stacks;
    const rootStack = transformOutput.rootStack;

    // Get all the transform stacks. Custom stacks will depend on all of them
    // so they can always access data sources created by the transform.
    const resourceTypesToDependOn = {
        "AWS::CloudFormation::Stack": true,
        "AWS::AppSync::GraphQLApi": true,
        "AWS::AppSync::GraphQLSchema": true,
    };
    const allResourceIds = Object.keys(rootStack.Resources).filter(
        (k: string) => {
            const resource = rootStack.Resources[k];
            return resourceTypesToDependOn[resource.Type];
        }
    );
    const parametersKeys = Object.keys(rootStack.Parameters);
    const customStackParams = parametersKeys.reduce((acc: any, k: string) => ({
        ...acc,
        [k]: Fn.Ref(k)
    }), {})
    customStackParams[ResourceConstants.PARAMETERS.AppSyncApiId] = Fn.GetAtt(
        ResourceConstants.RESOURCES.GraphQLAPILogicalID,
        'ApiId'
    );

    for (const userStack of Object.keys(userStacks)) {
        if (transformOutput.stacks[userStack]) {
            throw new Error(`You cannot provide a stack named ${userStack} as it \
            will be overwritten by a stack generated by the GraphQL Transform.`)
        }
        const userDefinedStack = userConfig.stacks[userStack];
        // Providing a parameter value when the parameters is not explicitly defined
        // in the template causes CloudFormation to throw and error. This will only
        // provide the value to the nested stack if the user has specified it.
        const parametersForStack = Object.keys(userDefinedStack.Parameters).reduce((acc, k) => ({
            ...acc,
            [k]: customStackParams[k],
        }), {});
        transformStacks[userStack] = userDefinedStack;
        // Split on non alphabetic characters to make a valid resource id.
        const stackResourceId = userStack.split(/[^A-Za-z]/).join('');
        const customNestedStack = new CloudFormation.Stack({
            Parameters: parametersForStack,
            TemplateURL: Fn.Join(
                '/',
                [
                    "https://s3.amazonaws.com",
                    Fn.Ref(ResourceConstants.PARAMETERS.S3DeploymentBucket),
                    Fn.Ref(ResourceConstants.PARAMETERS.S3DeploymentRootKey),
                    'stacks',
                    userStack
                ]
            )
        }).dependsOn(allResourceIds);
        rootStack.Resources[stackResourceId] = customNestedStack;
    }
    return {
        ...transformOutput,
        resolvers: transformResolvers,
        stacks: transformStacks
    }
}

export async function readSchema(projectDirectory: string) {
    const schemaFilePath = path.join(projectDirectory, 'schema.graphql')
    const schemaDirectoryPath = path.join(projectDirectory, 'schema')
    const schemaFileExists = await exists(schemaFilePath);
    const schemaDirectoryExists = await exists(schemaDirectoryPath);
    let schema;
    if (schemaFileExists) {
        schema = (await readFile(schemaFilePath)).toString()
    } else if (schemaDirectoryExists) {
        schema = (await readSchemaDocuments(schemaDirectoryPath)).join('\n');
    } else {
        throw new Error(`Could not find a schema at ${schemaFilePath}`)
    }
    return schema;
}

/**
 * Given an absolute path to an amplify project directory, load the
 * user defined configuration.
 */
export async function readProjectConfiguration(projectDirectory: string) {
    // Schema
    const schema = await readSchema(projectDirectory);
    // Load the resolvers.
    const resolverDirectory = path.join(projectDirectory, 'resolvers')
    const resolverDirExists = await exists(resolverDirectory);
    const resolvers = {}
    if (resolverDirExists) {
        const resolverFiles = await readDir(resolverDirectory)
        for (const resolverFile of resolverFiles) {
            const resolverFilePath = path.join(resolverDirectory, resolverFile)
            resolvers[resolverFile] = await readFile(resolverFilePath)
        }
    }
    // Load the functions. TODO: Do we want to do this? Ideally push towards using amplify add function.
    // const functionsDirectory = path.join(projectDirectory, 'functions')
    // const functionsDirExists = await exists(functionsDirectory)
    // const functions = {}
    // if (functionsDirExists) {
    //     const functionFiles = await readDir(functionsDirectory)
    //     for (const functionFile of functionFiles) {
    //         const functionFilePath = path.join(functionsDirectory, functionFile)
    //         functions[functionFile] = await readFile(functionFilePath)
    //     }
    // }
    // Load the stacks.
    const stacksDirectory = path.join(projectDirectory, 'stacks')
    const stacksDirExists = await exists(stacksDirectory)
    const stacks = {}
    if (stacksDirExists) {
        const stackFiles = await readDir(stacksDirectory)
        for (const stackFile of stackFiles) {
            const stackFilePath = path.join(stacksDirectory, stackFile)
            throwIfNotJSON(stackFile);
            const stackBuffer = await readFile(stackFilePath);
            try {
                stacks[stackFile] = JSON.parse(stackBuffer.toString());
            } catch (e) {
                throw new Error(`The CloudFormation template ${stackFiles} does not contain valid JSON.`)
            }
        }
    }
    return {
        stacks,
        resolvers,
        schema
    }
}

function throwIfNotJSON(stackFile: string) {
    const nameParts = stackFile.split('.');
    const extension = nameParts[nameParts.length - 1];
    if (extension === "yaml" || extension === "yml") {
        throw new Error(`Yaml is not yet supported. Please convert the CloudFormation stack ${stackFile} to json.`)
    }
    if (extension !== "json") {
        throw new Error(`Invalid extension .${extension} for stack ${stackFile}`);
    }
}

export interface UploadOptions {
    directory: string,
    upload(blob: { Key: string, Body: Buffer | string}): Promise<string>
}
/**
 * Reads deployment assets from disk and uploads to the cloud via an uploader.
 * @param opts Deployment options.
 */
export async function uploadDeployment(opts: UploadOptions) {
    try {
        if (!opts.directory) {
            throw new Error(`You must provide a 'directory'`)
        } else if (!fs.existsSync(opts.directory)) {
            throw new Error(`Invalid 'directory': directory does not exist at ${opts.directory}`)
        }
        if (!opts.upload || typeof opts.upload !== 'function') {
            throw new Error(`You must provide an 'upload' function`)
        }
        await uploadDirectory(opts)
    } catch (e) {
        throw e
    }
}

/**
 * Uploads a file with exponential backoff up to a point.
 * @param opts The deployment options
 * @param key The bucket key
 * @param body The blob body as a buffer
 * @param backoffMS The time to wait this invocation
 * @param numTries The max number of tries
 */
async function uploadFile(opts: UploadOptions, key: string, body: Buffer, backoffMS: number = 1000, numTries: number = 5) {
    try {
        return await opts.upload({
            Key: key,
            Body: body
        })
    } catch (e) {
        if (numTries > 1) {
            await new Promise((res, rej) => setTimeout(() => res(), backoffMS))
            await uploadFile(opts, key, body, backoffMS * 2, numTries - 1)
        }
        throw e
    }
}

async function uploadDirectory(opts: UploadOptions, key: string = '') {
    const files = await readDir(opts.directory)
    for (const file of files) {
        const resourcePath = path.join(opts.directory, file)
        const uploadKey = path.join(key, file)
        const isDirectory = (await lstat(resourcePath)).isDirectory()
        if (isDirectory) {
            await uploadDirectory({ ...opts, directory: resourcePath }, uploadKey)
        } else {
            const resourceContents = await readFile(resourcePath);
            await uploadFile(opts, uploadKey, resourceContents)
        }
    }
}

function emptyDirectory(directory: string) {
    const files = fs.readdirSync(directory)
    for (const file of files) {
        const resourcePath = path.join(directory, file)
        const isDirectory = fs.lstatSync(resourcePath).isDirectory()
        if (isDirectory) {
            emptyDirectory(resourcePath)
        } else {
            fs.unlinkSync(resourcePath);
        }
    }
}

/**
 * Writes a deployment to disk at a path.
 */
async function writeDeploymentToDisk(deployment: DeploymentResources, directory: string, rootStackFileName: string = 'rootStack.json') {

    // Delete the last deployments resources.
    emptyDirectory(directory)

    // Write the schema to disk
    const schema = deployment.schema;
    const fullSchemaPath = path.normalize(directory + `/schema.graphql`)
    fs.writeFileSync(fullSchemaPath, schema)

    // Write resolvers to disk
    const resolverFileNames = Object.keys(deployment.resolvers);
    const resolverRootPath = path.normalize(directory + `/resolvers`)
    if (!fs.existsSync(resolverRootPath)) {
        fs.mkdirSync(resolverRootPath);
    }
    for (const resolverFileName of resolverFileNames) {
        const fullResolverPath = path.normalize(resolverRootPath + '/' + resolverFileName);
        fs.writeFileSync(fullResolverPath, deployment.resolvers[resolverFileName]);
    }

    // Write the stacks to disk
    const stackNames = Object.keys(deployment.stacks);
    const stackRootPath = path.normalize(directory + `/stacks`)
    if (!fs.existsSync(stackRootPath)) {
        fs.mkdirSync(stackRootPath);
    }
    for (const stackFileName of stackNames) {
        const fileNameParts = stackFileName.split('.');
        if (fileNameParts.length === 1) {
            fileNameParts.push('json')
        }
        const fullFileName = fileNameParts.join('.');
        throwIfNotJSON(fullFileName);
        const fullStackPath = path.normalize(stackRootPath + '/' + fullFileName);
        let stackString: any = deployment.stacks[stackFileName];
        stackString = typeof stackString === 'string' ? deployment.stacks[stackFileName] : JSON.stringify(deployment.stacks[stackFileName], null, 4);
        fs.writeFileSync(fullStackPath, stackString);
    }

    // Write any functions to disk
    const functionNames = Object.keys(deployment.functions);
    const functionRootPath = path.normalize(directory + `/functions`)
    if (!fs.existsSync(functionRootPath)) {
        fs.mkdirSync(functionRootPath);
    }
    for (const functionName of functionNames) {
        const fullFunctionPath = path.normalize(functionRootPath + '/' + functionName);
        const zipContents = fs.readFileSync(deployment.functions[functionName])
        fs.writeFileSync(fullFunctionPath, zipContents);
    }
    const rootStack = deployment.rootStack;
    const rootStackPath = path.normalize(directory + `/${rootStackFileName}`);
    fs.writeFileSync(rootStackPath, JSON.stringify(rootStack, null, 4));
}

async function readSchemaDocuments(schemaDirectoryPath: string): Promise<string[]> {
    const files = await readDir(schemaDirectoryPath);
    let schemaDocuments = [];
    for (const fileName of files) {
        const fullPath = `${schemaDirectoryPath}/${fileName}`;
        const stats = await lstat(fullPath);
        if (stats.isDirectory()) {
            const childDocs = await readSchemaDocuments(fullPath);
            schemaDocuments = schemaDocuments.concat(childDocs);
        } else if (stats.isFile()) {
            const schemaDoc = await readFile(fullPath);
            schemaDocuments.push(schemaDoc);
        }
    }
    return schemaDocuments;
}

const readDir = async (dir: string) => await promisify<string, string[]>(fs.readdir, dir)
const readFile = async (p: string) => await promisify(fs.readFile, p)
const lstat = async (dir: string) => await promisify(fs.lstat, dir)
const exists = async (p: string) => await new Promise((res) => fs.exists(p, e => res(e)))
const unlink = async (p: string) => await new Promise((res, rej) => fs.unlink(p, e => e ? rej(e) : res()))
function promisify<A, O>(fn: (arg: A, cb: (err: Error, data: O) => void) => void, a: A): Promise<O> {
    return new Promise((res, rej) => {
        fn(a, (err, d) => {
            err ? rej(err) : res(d)
        })
    })
}