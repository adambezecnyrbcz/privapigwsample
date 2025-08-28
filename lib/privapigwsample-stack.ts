import * as cdk from 'aws-cdk-lib';
import {RemovalPolicy, Token} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {
  InterfaceVpcEndpoint,
  InterfaceVpcEndpointAwsService,
  IVpc,
  Peer,
  Port,
  SecurityGroup,
  Subnet,
  SubnetSelection,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import {CfnRecordSet, PrivateHostedZone, PublicHostedZone, RecordType} from "aws-cdk-lib/aws-route53";
import {Certificate, CertificateValidation} from "aws-cdk-lib/aws-certificatemanager";
import * as aws_apigateway from "aws-cdk-lib/aws-apigateway";
import {
  AccessLogField,
  AccessLogFormat,
  ConnectionType,
  Integration,
  IntegrationType
} from "aws-cdk-lib/aws-apigateway";
import * as aws_apigateway_v2 from 'aws-cdk-lib/aws-apigatewayv2';
import {NetworkLoadBalancer} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {IpTarget} from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import {AwsCustomResource, AwsCustomResourcePolicy, AwsSdkCall, PhysicalResourceId} from "aws-cdk-lib/custom-resources";
import * as aws_logs from "aws-cdk-lib/aws-logs";

function getDescribeVpcEndpointAwsSdkCall(vpceId: string): AwsSdkCall {
  return {
    service: "EC2",
    action: "describeVpcEndpoints",
    outputPaths: [
        `VpcEndpoints.0.NetworkInterfaceIds.0`,
        `VpcEndpoints.0.DnsEntries.0.DnsName`,
        `VpcEndpoints.0.DnsEntries.0.HostedZoneId`,
    ],
    parameters: {
      VpcEndpointIds: [vpceId],
    },
    physicalResourceId: PhysicalResourceId.of(`${vpceId}-VpceDescribe-${new Date().getTime()}`),
  };
}

function getDescribeNetworkInterfacesAwsSdkCall(eniId: string): AwsSdkCall {
  return {
    service: 'EC2',
    action: 'describeNetworkInterfaces',
    outputPaths: [`NetworkInterfaces.0.PrivateIpAddress`],
    parameters: {
      NetworkInterfaceIds: [eniId],
      Filters: [
        { Name: "interface-type", Values: ["vpc_endpoint"] }
      ],
    },
    physicalResourceId: PhysicalResourceId.of(`${eniId}-VpceEniLookup-${new Date().getTime()}`),
  };
}

// aws ec2 describe-vpc-endpoints --vpc-endpoint-ids vpce-xxxx
class VpceDescribe extends Construct {
  public readonly vpceENI: string;
  public readonly vpceDns: string;
  public readonly vpceHZ: string;
  constructor(scope: Construct, id: string, props: { vpceId: string }) {
    super(scope, id);
    const customResource = new AwsCustomResource(this, "VpceDescribeCustomAwsResource", {
      onCreate: getDescribeVpcEndpointAwsSdkCall(props.vpceId),
      onUpdate: getDescribeVpcEndpointAwsSdkCall(props.vpceId),
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
    });

    // see https://stackoverflow.com/questions/76962122/cannot-use-response-from-aws-customresource-in-cdk-via-awssdkcall
    this.vpceENI=Token.asString(customResource.getResponseField('VpcEndpoints.0.NetworkInterfaceIds.0'));
    this.vpceDns=Token.asString(customResource.getResponseField('VpcEndpoints.0.DnsEntries.0.DnsName'));
    this.vpceHZ=Token.asString(customResource.getResponseField('VpcEndpoints.0.DnsEntries.0.HostedZoneId'));
  }
}

class VpceEniLookup extends Construct {
  public readonly eniPrivateIp: string;

  constructor(scope: Construct, id: string, props: { eniId: string }) {
    super(scope, id);

    const eniLookup = new AwsCustomResource(this, 'VpceEniLookupAwsCustomResource', {
      onCreate: getDescribeNetworkInterfacesAwsSdkCall(props.eniId),
      onUpdate: getDescribeNetworkInterfacesAwsSdkCall(props.eniId),
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
    });

    // see https://stackoverflow.com/questions/76962122/cannot-use-response-from-aws-customresource-in-cdk-via-awssdkcall
    this.eniPrivateIp = Token.asString(eniLookup.getResponseField('NetworkInterfaces.0.PrivateIpAddress'));
  }
}

export class PrivapigwsampleStack extends cdk.Stack {
  private accessLogGroup: aws_logs.LogGroup;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpcIdParam = this.node.tryGetContext('VpcIdParam') || 'vpc-xxx';
    const vpcPrivIsolatedSubnetIdParam = this.node.tryGetContext('VpcPrivIsolatedSubnetIdParam') || 'subnet-xxx';
    const publicHostedZoneParam = this.node.tryGetContext('PubHostedZoneParam') || 'Z070715xGxx6xxx';
    const privateHostedZoneParam = this.node.tryGetContext('PrivHostedZoneParam') || 'Z08034982Xxxx';
    const domainNameParam = this.node.tryGetContext('DomainNameParam') || 'example.com';

    console.log("using vpcIdParam " + vpcIdParam);
    console.log("using vpcPrivIsolatedSubnetIdParam " + vpcPrivIsolatedSubnetIdParam);
    console.log("using publicHostedZoneParam " + publicHostedZoneParam);
    console.log("using privateHostedZoneParam " + privateHostedZoneParam);
    console.log("using domainNameParam " + domainNameParam);

    //
    // Resources imported from AWS environment based on params
    //

    const vpc: IVpc = Vpc.fromLookup(this, 'ImportedVpc', {
      vpcId: vpcIdParam,
    });
    const vpcSubnet = Subnet.fromSubnetAttributes(this, "ImportedSubnetVpc" , {
      subnetId: vpcPrivIsolatedSubnetIdParam,
    });
    const subnetsSelection: SubnetSelection = {
      subnets: [vpcSubnet],
    };

    const hostedZonePublic = PublicHostedZone.fromHostedZoneAttributes(this, "HostedZonePublic",{
      hostedZoneId:publicHostedZoneParam,
      zoneName: domainNameParam,
    });

    const hostedZonePrivate = PrivateHostedZone.fromHostedZoneAttributes(this, "HostedZonePrivate",{
      hostedZoneId: privateHostedZoneParam,
      zoneName: domainNameParam,
    });



    //
    // Custom CDK constructs
    //

    const customDNSInternal = `privateapigwsample.${domainNameParam}`;
    const wildCardDNS = `*.${domainNameParam}`;

    const apiGWCertificate = new Certificate(this, "apiGWCertificateForInternalProxy", {
      domainName: customDNSInternal,
      validation: CertificateValidation.fromDns(hostedZonePublic),
    });

    const nlbCertificate = new Certificate(this, "networkLBCertificateForInternalProxy", {
      domainName: wildCardDNS,
      validation: CertificateValidation.fromDns(hostedZonePublic),
    });


    const policy = new cdk.aws_iam.PolicyStatement({
      effect: cdk.aws_iam.Effect.ALLOW,
      principals: [new cdk.aws_iam.AnyPrincipal()],
      actions: ['*'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          "aws:SourceVpc": vpcIdParam
        }
      }
    });

    const securityGroup443 = new SecurityGroup(
        this,
        "VPCEndpointSecurityGroup",
        {
          vpc: vpc,
          description: "Security group for API Gateway VPC endpoint",
          allowAllOutbound: true,
        }
    );
    securityGroup443.addIngressRule(
        Peer.anyIpv4(),
        Port.tcp(443),
        "Allow HTTPS traffic from anywhere"
    );


    //*******GENERIC VPC endpoint for inbound*******
    const GenericDigitalProxyVPCEndpointInbound = new InterfaceVpcEndpoint(this, "GenericInternalDigitalProxyVPCEndpointInbound", {
      service: InterfaceVpcEndpointAwsService.APIGATEWAY,
      vpc: vpc,
      privateDnsEnabled: false,
      subnets: {
        subnets: [vpcSubnet],
      },
      securityGroups: [securityGroup443],
    });
    GenericDigitalProxyVPCEndpointInbound.addToPolicy(policy);
    cdk.Tags.of(GenericDigitalProxyVPCEndpointInbound).add("Name", "privateapigwsample-generic-vpce-inbound");


    //*******GENERIC VPC endpoint for outbound*******
    const GenericDigitalProxyVPCEndpointOutbound = new InterfaceVpcEndpoint(this, "GenericInternalDigitalProxyVPCEndpointOutbound", {
      service: InterfaceVpcEndpointAwsService.APIGATEWAY,
      vpc: vpc,
      privateDnsEnabled: false,
      subnets: {
        subnets: [vpcSubnet],
      },
      securityGroups: [securityGroup443],
    });
    GenericDigitalProxyVPCEndpointOutbound.addToPolicy(policy);
    cdk.Tags.of(GenericDigitalProxyVPCEndpointOutbound).add("Name", "privateapigwsample-generic-vpce-outbound");


    // Create the API Gateway custom domain name
    // see https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_apigatewayv2-readme.html
    const domainName = new aws_apigateway.CfnDomainNameV2(this, 'ApiGatewayDomainNameForInternalProxy', {
      domainName: customDNSInternal,
      certificateArn: apiGWCertificate.certificateArn,
      securityPolicy: aws_apigateway_v2.SecurityPolicy.TLS_1_2,
      endpointConfiguration: {
        types: ["PRIVATE"],
      },
      // policy as per AWS sample: https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-private-custom-domains-tutorial.html
      policy: JSON.stringify({
        Statement: [
          {
            "Effect": "Allow",
            "Principal": "*",
            "Action": "execute-api:Invoke",
            "Resource": [
              "execute-api:/*"
            ]
          },
          {
            "Effect": "Deny",
            "Principal": "*",
            "Action": "execute-api:Invoke",
            "Resource": [
              "execute-api:/*"
            ],
            "Condition" : {
              "StringNotEquals": {
                "aws:SourceVpce":  GenericDigitalProxyVPCEndpointInbound.vpcEndpointId
              }
            }
          }
        ]
      })
    });

    const vpceDescribeOutbound = new VpceDescribe(this, "VpceDescribeGenericVPCEOutbound", {vpceId: GenericDigitalProxyVPCEndpointOutbound.vpcEndpointId});
    const vpceDescribeInbound = new VpceDescribe(this, "VpceDescribeGenericVPCEInbound", {vpceId: GenericDigitalProxyVPCEndpointInbound.vpcEndpointId});
    const vpceEniLookup = new VpceEniLookup(this, 'VpceEniLookupGenericVPCEOutbound', { eniId: vpceDescribeOutbound.vpceENI });

    const GenericNLB = new NetworkLoadBalancer(this, "GenericNLB", {
      vpc,
      vpcSubnets: subnetsSelection,
      internetFacing: false,
      //securityGroups:[nlbSecurityGroup],
    });

    const GenericListener443 = GenericNLB.addListener("GenericListener443", {
      port: 443,
      certificates: [nlbCertificate],
    });

    GenericListener443.addTargets("GenericTarget443", {
      port: 443,
      targets: [new IpTarget(vpceEniLookup.eniPrivateIp, 443)],
    });

    const GenericVPCLink = new aws_apigateway.VpcLink(this, "GenericVPCLinkForInternalProxy", {
      targets: [GenericNLB],
    });


    this.accessLogGroup = new aws_logs.LogGroup(this, "ApiGWAccessLog", {
      logGroupName: "privateapigwsample-ApiGWAccessLog",
      retention: 3,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const sgLambda = new SecurityGroup(this, 'AllowAllSG', {
      vpc,
      description: 'Security group that allows all traffic',
      allowAllOutbound: true,
    });
    sgLambda.addIngressRule(Peer.anyIpv4(), Port.allTraffic(), 'Allow all IPv4 traffic');
    sgLambda.addIngressRule(Peer.anyIpv6(), Port.allTraffic(), 'Allow all IPv6 traffic');

    const simpleLambda = new cdk.aws_lambda.Function(this, 'SimpleLambda', {
      runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: cdk.aws_lambda.Code.fromInline(`
    exports.handler = async function(event) {
      return { statusCode: 200, body: "Hello from Lambda!" };
    };
  `),
    });

    const api = new aws_apigateway.RestApi(this, "ApiGW-test-api", {
      defaultMethodOptions: {
        authorizationType: aws_apigateway.AuthorizationType.NONE,
      },
      restApiName: "privateapigwsample-test-api",
      deployOptions: {
        stageName: "api",
        accessLogDestination: new aws_apigateway.LogGroupLogDestination(this.accessLogGroup),
        //accessLogFormat: generateAccessLogFormat(),
        loggingLevel: aws_apigateway.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
        tracingEnabled: true,

        methodOptions: {
          "/*/*": {},
        },
      },
      endpointTypes: [aws_apigateway.EndpointType.PRIVATE],
      policy: new cdk.aws_iam.PolicyDocument({
        statements: [
          new cdk.aws_iam.PolicyStatement({
            actions: ["execute-api:Invoke"],
            resources: ["*"],
            effect: cdk.aws_iam.Effect.DENY,
            principals: [new cdk.aws_iam.AnyPrincipal()],
            conditions: {
              StringNotEquals: {
                "aws:sourceVpce": [
                  GenericDigitalProxyVPCEndpointOutbound.vpcEndpointId,
                ]
              },
            },
          }),
          new cdk.aws_iam.PolicyStatement({
            actions: ["execute-api:Invoke"],
            resources: [`*`],
            effect: cdk.aws_iam.Effect.ALLOW,
            principals: [new cdk.aws_iam.AnyPrincipal()],
          }),
        ],
      }),
    });
    const AR_test =  api.root.addResource("test");
    AR_test.addMethod("GET", new aws_apigateway.LambdaIntegration(simpleLambda), {});


    const apiProxy = new aws_apigateway.RestApi(this, "ApiGW-proxy-api", {
      defaultMethodOptions: {
        authorizationType: aws_apigateway.AuthorizationType.NONE,
      },
      restApiName: "privateapigwsample-proxy-api",
      deployOptions: {
        stageName: "api",
        accessLogDestination: new aws_apigateway.LogGroupLogDestination(this.accessLogGroup),
        accessLogFormat: AccessLogFormat.custom(
            JSON.stringify({
              requestId: AccessLogField.contextRequestId(),
              sourceIp: AccessLogField.contextIdentitySourceIp(),
              user: AccessLogField.contextIdentityUser(),
              requestTime: AccessLogField.contextRequestTime(),
              httpMethod: AccessLogField.contextHttpMethod(),
              resourcePath: AccessLogField.contextResourcePath(),
              status: AccessLogField.contextStatus(),
              protocol: AccessLogField.contextProtocol(),
              responseLength: AccessLogField.contextResponseLength(),
              wafError: AccessLogField.contextWafError(),
              wafStatus: AccessLogField.contextWafStatus(),
              wafLatency: AccessLogField.contextWafLatency(),
              wafResponseCode: AccessLogField.contextWafResponseCode(),
              authenticateError: AccessLogField.contextAuthenticateError(),
              authentificateStatus: AccessLogField.contextAuthenticateStatus(),
              authentificateLatency: AccessLogField.contextAuthenticateLatency(),
              authorizerError: AccessLogField.contextAuthorizeError(),
              authorizeStatus: AccessLogField.contextAuthorizeStatus(),
              authorizeLatency: AccessLogField.contextAuthorizeLatency(),
              integrationError: AccessLogField.contextIntegrationErrorMessage(),
              integrationLatency: AccessLogField.contextIntegrationLatency(),
              integrationStatus: AccessLogField.contextIntegrationStatus(),
              responseLatency: AccessLogField.contextResponseLatency(),
            })
        ),
        loggingLevel: aws_apigateway.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
        tracingEnabled: true,

        methodOptions: {
          "/*/*": {},
        },
      },
      endpointTypes: [aws_apigateway.EndpointType.PRIVATE],
      policy: new cdk.aws_iam.PolicyDocument({
        statements: [
          new cdk.aws_iam.PolicyStatement({
            actions: ["execute-api:Invoke"],
            resources: ["*"],
            effect: cdk.aws_iam.Effect.DENY,
            principals: [new cdk.aws_iam.AnyPrincipal()],
            conditions: {
              StringNotEquals: {
                "aws:sourceVpce": [
                  GenericDigitalProxyVPCEndpointInbound.vpcEndpointId,
                ],
              },
            },
          }),
          new cdk.aws_iam.PolicyStatement({
            actions: ["execute-api:Invoke"],
            resources: [`*`],
            effect: cdk.aws_iam.Effect.ALLOW,
            principals: [new cdk.aws_iam.AnyPrincipal()],
          }),
        ],
      }),
      disableExecuteApiEndpoint: true,
    });

    //*************HTTP PROXY INTEGRATION*************
    const proxyIntegration = new Integration({
      type: IntegrationType.HTTP_PROXY,
      integrationHttpMethod: "ANY",
      uri: `https://${GenericNLB.loadBalancerName}.${domainNameParam}/api/{proxy}`,
      options:{
        connectionType: ConnectionType.VPC_LINK,
        vpcLink: GenericVPCLink,
        requestParameters: {
          "integration.request.path.proxy": "method.request.path.proxy",
          "integration.request.header.x-apigw-api-id": `'${api.restApiId}'`,
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseTemplates: {
              "application/json": "",
            },
          },
        ],
      },
    });

    apiProxy.root
        .addResource("http-proxy-integration")
        .addResource("{proxy+}")
        .addMethod("ANY", proxyIntegration, {
          requestParameters: {
            "method.request.path.proxy": true,
          },
          methodResponses: [
            {statusCode: "200"},
          ],
        });
    //*************HTTP PROXY INTEGRATION END*************

    //*************HTTP INTEGRATION*************
    const httpIntegration = new Integration({
      type: IntegrationType.HTTP,
      integrationHttpMethod: "ANY",
      uri: `https://${GenericNLB.loadBalancerName}.${domainNameParam}/api/{proxy}`,
      options:{
        connectionType: ConnectionType.VPC_LINK,
        vpcLink: GenericVPCLink,
        requestParameters: {
          "integration.request.path.proxy": "method.request.path.proxy",
          "integration.request.header.x-apigw-api-id": `'${api.restApiId}'`,
        },
        passthroughBehavior: aws_apigateway.PassthroughBehavior.WHEN_NO_MATCH,
        requestTemplates: {
          "application/json": `
#set($allParams = $input.params())
#set($headers = $allParams.get('header'))
#set($body = $input.body)
{
    #if($body && $body != "")
    "body": $body,
    #end
    "headers": {
        #foreach($header in $headers.keySet())
            #if($header.toLowerCase() != "x-amzn-vpce-config")
                "$header": "$util.escapeJavaScript($headers.get($header))"
                #if($foreach.hasNext),#end
            #end
        #end
    }
}                    
                    `,
        },
        integrationResponses: [
          {
            statusCode: "200",
            selectionPattern: "2\\d{2}", // Matches any 2xx status code
            responseTemplates: {},
          },
          {
            statusCode: "400",
            selectionPattern: "400",
            responseTemplates: {},
          },
          {
            statusCode: "401",
            selectionPattern: "401",
            responseTemplates: {},
          },
          {
            statusCode: "403",
            selectionPattern: "403",
            responseTemplates: {},
          },
          {
            statusCode: "404",
            selectionPattern: "404",
            responseTemplates: {},
          },
          {
            statusCode: "500",
            selectionPattern: "5\\d{2}", // Matches any 5xx status code
            responseTemplates: {},
          },
        ],
      },
    });

    apiProxy.root
        .addResource("http-integration")
        .addResource("{proxy+}")
        .addMethod("ANY", httpIntegration, {
          requestParameters: {
            "method.request.path.proxy": true,
          },
          methodResponses: [
            {statusCode: "200"},
            {statusCode: "400"},
            {statusCode: "401"},
            {statusCode: "403"},
            {statusCode: "404"},
            {statusCode: "500"},
          ],
        });

    //*************HTTP INTEGRATION END*************

    // Create an API mapping (see custom domain names -> <<domain name>>> -> Routing details -> API mappings)
    new aws_apigateway.CfnBasePathMappingV2(this, 'ApiMappingForInternalProxy', {
      domainNameArn: domainName.attrDomainNameArn,
      restApiId: apiProxy.restApiId,
      stage: apiProxy.deploymentStage.stageName,
    });

    // custom domain association to VPCE
    new aws_apigateway.CfnDomainNameAccessAssociation(this, `DomainNameAccessAssociationForInternalProxy`, {
      accessAssociationSource: GenericDigitalProxyVPCEndpointInbound.vpcEndpointId,
      accessAssociationSourceType: 'VPCE',
      domainNameArn: domainName.attrDomainNameArn
    });

    // DNS 'A record' to VPCE
    new CfnRecordSet(this, `PrivateDNSRecordToProxyInternalGenericVPCE`, {
      hostedZoneId: hostedZonePrivate.hostedZoneId,
      name: customDNSInternal,
      type: RecordType.A,
      aliasTarget: {
        dnsName: vpceDescribeInbound.vpceDns,
        hostedZoneId: vpceDescribeInbound.vpceHZ,
      }
    });

    //
    // stack outputs (testing commands)
    //

    new cdk.CfnOutput(this, 'CallTestApiWithOutboundVPCE', {
      value: `curl -X GET https://${vpceDescribeOutbound.vpceDns}/api/test   --header 'x-apigw-api-id: ${api.restApiId}'`,
    });

    new cdk.CfnOutput(this, 'CallTestApiWithProxyAndHttpIntegration', {
      value: `curl -X GET https://${customDNSInternal}/http-integration/test`,
    });

    new cdk.CfnOutput(this, 'CallTestApiWithProxyAndHttpProxyIntegration', {
      value: `curl -X GET https://${customDNSInternal}/http-proxy-integration/test`,
    });

  }// stack constructor end
} //stack end
