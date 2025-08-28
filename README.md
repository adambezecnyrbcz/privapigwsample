# API Gateway HTTP versus HTTP_PROXY integration demonstrator

This stack replicates the issue when calling internal api with **HTTP_PROXY** integration. If very same lambda backend
is called with **HTTP** integration it works but we must manually remove header **x-amzn-vpce-config**! This repo will be used for demonstrating the issue to AWS support.

# Design

<img src="./docs/design v1.png" />

## How to deploy

Export following variables to make sure you will be deploying to your AWS account:
```bash
export CDK_DEFAULT_ACCOUNT=123456789
export AWS_ACCESS_KEY_ID=AKXXXF2IYITXXXXXXX
export AWS_SECRET_ACCESS_KEY="mQxxx4QfIKH0xxxxxxxxxxR8ac4NFQh86F"
```

Run following command
```bash
npx cdk deploy --context VpcIdParam=vpc-03117b72feb7dxxxx --context VpcPrivIsolatedSubnetIdParam=subnet-09dcbfd0c9d72xxxx --context PubHostedZoneParam=Z08034982X6XXXXYYYY --context PrivHostedZoneParam=Z08034982X6IYJHBBXXXX --context DomainNameParam=example.com
```
Where:  

* **VpcIdParam** is your VPC. VPC **must** have following parameters enabled: DNS resolution, DNS hostnames resolution
* **VpcPrivIsolatedSubnetIdParam** is subnet within VPC that is private (no IGW in route table, ideally no NAT)
* **PubHostedZoneParam** is ID of your Route53 **public** hosted zone to your domain (example.com in command above)
* **PrivHostedZoneParam** is ID of your Route53 ***private** hosted zone to your domain (example.com in command above)
* **DomainNameParam** is your domain, e.g. example.com

Stack will be deployed into **eu-central-1** region.

## Testing

See CDK Stack outputs for testing commands:

* CallTestApiWithOutboundVPCE
  * this should work and should return **Hello from Lambda!** 
* CallTestApiWithProxyAndHttpIntegration
  * this should work and should return **Hello from Lambda!**
* CallTestApiWithProxyAndHttpProxyIntegration
  * this should not work and should return **Network error communicating with endpoint*** 



