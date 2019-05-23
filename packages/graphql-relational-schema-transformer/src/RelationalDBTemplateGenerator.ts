import { ResourceConstants } from './ResourceConstants'
import DataSource from 'cloudform-types/types/appSync/dataSource'
import IAM from 'cloudform-types/types/iam'

import cloudform, { Fn, StringParameter, Refs } from 'cloudform'
import Template from 'cloudform-types/types/template'
import TemplateContext from './RelationalDBSchemaTransformer'
import RelationalDBResolverGenerator from './RelationalDBResolverGenerator'

/**
 * This is the Class responsible for generating and managing the CloudForm template
 * provided a TemplateContext object, which is generated by the RelationalDBSchemaTransformer.
 *
 * It will generate the basic CloudForm template needed for getting the AppSync API and
 * RDS DataSource provisioned. It also allows for adding the CRUDL+Q Resolvers upon need.
 */
export default class RelationalDBTemplateGenerator {
    context: TemplateContext

    constructor(context: TemplateContext) {
        this.context = context
    }

    /**
     * Creates and returns the basic Cloudform template needed for setting
     * up an AppSync API pointing at the RDS DataSource.
     * 
     * @returns the created CloudFormation template.
     */
    public createTemplate(context: any): Template {
        const template =  {
            AWSTemplateFormatVersion: "2010-09-09",
            Parameters: this.makeParameters(this.context.databaseName),
            Resources: {
                [ResourceConstants.RESOURCES.RelationalDatabaseDataSource]: this.makeRelationalDataSource(context),
                [ResourceConstants.RESOURCES.RelationalDatabaseAccessRole]: this.makeIAMDataSourceRole()
            }
        }

        return template
    }

    /**
     * Provided a Cloudform Template, this method adds Resolver Resources to the
     * Template.
     *
     * @param template - the Cloudform template
     * @returns the given template, updated with new resolvers.
     */
    public addRelationalResolvers(template: Template, resolverFilePath: string) : Template {
        let resolverGenerator = new RelationalDBResolverGenerator(this.context)
        template.Resources = {...template.Resources, ...resolverGenerator.createRelationalResolvers(resolverFilePath)}
        return template
    }

    /**
     * Provided a Cloudform Template, this method returns the cfn json template as a string
     *
     * @param template - the Cloudform template
     * @returns the json, string form of the template given.
     */
    public printCloudformationTemplate(template: Template): string {
        return cloudform(template)
    }

    /*
     * Private Helper Methods for Generating the Necessary CFN Specs for the CFN Template
     */

    /**
     * Creates any Parmaters needed for the CFN Template
     * 
     * @param databaseName - the name of the database being parsed.
     * @returns the parameters for the template.
     */
    private makeParameters(databaseName: string) {
        return {
            [ResourceConstants.PARAMETERS.AppSyncApiName]: new StringParameter({
                Description: `The name of the AppSync API generated from database ${databaseName}`,
                Default: `AppSyncSimpleTransform`
            }),
            [ResourceConstants.PARAMETERS.Env]: new StringParameter({
                Description: 'The environment name. e.g. Dev, Test, or Production',
                Default: 'NONE'
            }),
            [ResourceConstants.PARAMETERS.S3DeploymentBucket]: new StringParameter({
                Description: 'The S3 bucket containing all deployment assets for the project.'
            }),
            [ResourceConstants.PARAMETERS.S3DeploymentRootKey]: new StringParameter({
                Description: 'An S3 key relative to the S3DeploymentBucket that points to the root of the deployment directory.'
            }),
            [ResourceConstants.PARAMETERS.AppSyncApiId]: new StringParameter({
                Description: 'The id of the AppSync API associated with this project.'
            }),
            [ResourceConstants.PARAMETERS.rdsRegion]: new StringParameter({
                Description: 'The region that the RDS Cluster is located in.'
            }),
            [ResourceConstants.PARAMETERS.rdsClusterIdentifier]: new StringParameter({
                Description: 'The ARN identifier denoting the RDS cluster.'
            }),
            [ResourceConstants.PARAMETERS.rdsSecretStoreArn]: new StringParameter({
                Description: 'The ARN for the Secret containing the access for the RDS cluster.'
            }),
            [ResourceConstants.PARAMETERS.rdsDatabaseName]: new StringParameter({
                Description: 'The name of the database within the RDS cluster to use.'
            })
        }
    }

    /*
     * Resources
     */

    /**
     * Creates the IAM Role CFN Spec to allow AppSync to interact with the RDS cluster
     * 
     * @returns the IAM role CloudFormation resource.
     */
    private makeIAMDataSourceRole() {
        return new IAM.Role ({
            RoleName: Fn.Join('-', [
                'role',
                Fn.Ref(ResourceConstants.PARAMETERS.AppSyncApiId),
                Fn.Ref(ResourceConstants.PARAMETERS.Env)
            ]),

            AssumeRolePolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                    {
                        Effect: 'Allow',
                        Principal: {
                            Service: 'appsync.amazonaws.com'
                        },
                        Action: 'sts:AssumeRole'
                    }
                ]
            },
            Policies: [
                new IAM.Role.Policy ({
                    PolicyName: 'RelationalDatabaseAccessPolicy',
                    PolicyDocument: {
                        Version: '2012-10-17',
                        Statement: [
                            {
                                Effect: 'Allow',
                                Action: [
                                    'rds-data:ExecuteSql',
				    'rds-data:ExecuteStatement',
                                    'rds-data:DeleteItems',
                                    'rds-data:GetItems',
                                    'rds-data:InsertItems',
                                    'rds-data:UpdateItems'
                                ],
                                Resource: [
                                    Fn.Ref(ResourceConstants.PARAMETERS.rdsClusterIdentifier)
                                ]
                            },
                            {
                                Effect: 'Allow',
                                Action: [
                                    'secretsmanager:GetSecretValue'
                                ],
                                Resource: [
                                    Fn.Ref(ResourceConstants.PARAMETERS.rdsSecretStoreArn)
                                ]
                            }
                        ]
                    }
                })
            ]
        })
    }

    /**
     * Creates the AppSync DataSource CFN Spec pointing at the provided RDS Cluster
     * 
     * @param cliContext - the Amplify context, used to load environment variables.
     * @returns the data source CloudFormation resource.
     */
    private makeRelationalDataSource(cliContext: any): DataSource {
        return new DataSource ({
            Type: 'RELATIONAL_DATABASE',
            Name: `${this.context.databaseName}_rds_DataSource`,
            Description: `RDS Data Source Provisioned for ${this.context.databaseName}`,
            ApiId: Fn.Ref(ResourceConstants.PARAMETERS.AppSyncApiId),
            ServiceRoleArn: Fn.GetAtt(ResourceConstants.RESOURCES.RelationalDatabaseAccessRole, 'Arn'),
            RelationalDatabaseConfig: {
                RelationalDatabaseSourceType: 'RDS_HTTP_ENDPOINT',
                RdsHttpEndpointConfig: {
                    AwsRegion: Fn.Ref(ResourceConstants.PARAMETERS.rdsRegion),
                    DbClusterIdentifier: Fn.Ref(ResourceConstants.PARAMETERS.rdsClusterIdentifier),
                    DatabaseName: Fn.Ref(ResourceConstants.PARAMETERS.rdsDatabaseName),
                    Schema: this.context.databaseSchema,
                    AwsSecretStoreArn: Fn.Ref(ResourceConstants.PARAMETERS.rdsSecretStoreArn)
                }
            }
        }).dependsOn([ResourceConstants.RESOURCES.RelationalDatabaseAccessRole])
    }
}
