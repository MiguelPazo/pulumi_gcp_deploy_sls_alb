/**
 * Created by Miguel Pazo (https://miguelpazo.com)
 */

import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as config from "./config";
import * as fs from "fs";
import * as yaml from "js-yaml";

/**
 * VPC Connector
 */
const network = gcp.compute.Network.get(config.vpcNetwork, config.vpcNetwork);

const vpcConnector = new gcp.vpcaccess.Connector(`${config.generalPrefix}-vpcconn`, {
    name: `${config.generalPrefix}-vpcconn`,
    ipCidrRange: config.vpcConnectorRange,
    network: network.name
});

/**
 * External IPs for Load Balancer
 */
let externalIpBackend = new gcp.compute.GlobalAddress(`${config.generalPrefix}-external-ip-backend`);
let certificates = {};

createAliasRecord(config.targetDomain, externalIpBackend);

function createAliasRecord(targetDomain: string, externalIp) {
    const zoneTargetDomain = gcp.dns.ManagedZone.get(targetDomain, targetDomain.replace(/\./g, '-'));

    new gcp.dns.RecordSet(`${config.generalPrefix}-${targetDomain}-record-set`, {
        name: `${targetDomain}.`,
        type: "A",
        ttl: 600,
        managedZone: zoneTargetDomain.name,
        rrdatas: [externalIp.address]
    });

    // SSL certificates
    certificates[targetDomain] = new gcp.compute.ManagedSslCertificate(`${targetDomain.replace(/\./g, '-')}-ssl`, {
        managed: {
            domains: [`${targetDomain}.`],
        }
    });
}

/**
 * Load Balancer for backend
 */
let pathRules = [];
let backServFunctionDefault;
let count = 0;

const slsBucket = yaml.load(fs.readFileSync('source_code/configuration-template-create.yml', 'utf8'));
const slsConfigs = yaml.load(fs.readFileSync('source_code/configuration-template-update.yml', 'utf8'));

for (let slsFunction of slsConfigs.resources) {
    if (slsFunction.type.indexOf('storage') !== -1) {
        continue;
    }

    count++;

    const networkRegionEndpoint = new gcp.compute.RegionNetworkEndpointGroup(`${config.generalPrefix}-rne-${count}`, {
        networkEndpointType: "SERVERLESS",
        region: config.region,
        cloudFunction: {
            'function': slsFunction.name,
        },
    });

    const backServFunction = new gcp.compute.BackendService(`${config.generalPrefix}-alb-bsfunction-${count}`, {
        protocol: "HTTP",
        backends: [
            {
                group: networkRegionEndpoint.selfLink,
            },
        ],
        customResponseHeaders: [
            'X-Frame-Options: DENY',
            'X-XSS-Protection: 1; mode=block',
            "Content-Security-Policy: frame-ancestors 'self'",
            'Strict-Transport-Security: max-age=31536000; includesubdomains',
            'X-Content-Type-Options: nosniff',
            `X-Powered-By: ${config.albHeaderPoweredBy}`,
            'Cache-Control: no-cache="Set-Cookie"',
        ]
    });

    pathRules.push({
        paths: [
            slsFunction.properties.httpsTrigger.url,
        ],
        service: backServFunction.selfLink,
    });

    if (count === 1) {
        backServFunctionDefault = backServFunction;
    }
}


const albBackend = new gcp.compute.URLMap(`${config.generalPrefix}-alb-backend`, {
    defaultUrlRedirect: {
        hostRedirect: config.targetDomainRedirect,
        httpsRedirect: true,
        stripQuery: true,
    },
    hostRules: [
        {
            hosts: [config.targetDomain],
            pathMatcher: "allpaths",
        }
    ],
    pathMatchers: [
        {
            name: "allpaths",
            defaultService: backServFunctionDefault.selfLink,
            pathRules
        },
    ]
});

if (config.albHttpRoute) {
    const httpProxyBackend = new gcp.compute.TargetHttpProxy(`${config.generalPrefix}-alb-backend-proxy-http`, {
        urlMap: albBackend.selfLink,
    });

    new gcp.compute.GlobalForwardingRule(`${config.generalPrefix}-alb-backend-forward-http`, {
        target: httpProxyBackend.selfLink,
        ipAddress: externalIpBackend.address,
        portRange: "80",
    });
}

const sslPolicyFrontend = new gcp.compute.SSLPolicy(`${config.generalPrefix}-alb-backend-https-policy`, {
    minTlsVersion: 'TLS_1_2',
    profile: 'COMPATIBLE'
});

const httpsProxyBackend = new gcp.compute.TargetHttpsProxy(`${config.generalPrefix}-alb-backend-proxy-https`, {
    urlMap: albBackend.selfLink,
    sslPolicy: sslPolicyFrontend.selfLink,
    sslCertificates: [
        certificates[config.targetDomain].id,
    ],
});

new gcp.compute.GlobalForwardingRule(`${config.generalPrefix}-alb-backend-forward-https`, {
    target: httpsProxyBackend.selfLink,
    ipAddress: externalIpBackend.address,
    portRange: "443",
});

/**
 * Config functions
 */
const bucketName = slsBucket.resources[0].name.substring(0, slsBucket.resources[0].name.lastIndexOf('-'));
const archiveName = slsConfigs.resources[1].properties.sourceArchiveUrl.replace('gs://', '').replace(`${bucketName}/`, '');

const bucket = new gcp.storage.Bucket(bucketName, {name: bucketName});

const archive = new gcp.storage.BucketObject(archiveName, {
    name: archiveName,
    bucket: bucket.name,
    source: new pulumi.asset.FileAsset(`source_code/${config.slsServiceName}.zip`),
});

for (let slsFunction of slsConfigs.resources) {
    if (slsFunction.type.indexOf('storage') !== -1) {
        continue;
    }

    const slsFuncionDeployed = new gcp.cloudfunctions.Function(slsFunction.name, {
        name: slsFunction.name,
        runtime: slsFunction.properties.runtime,
        availableMemoryMb: slsFunction.properties.availableMemoryMb,
        sourceArchiveBucket: bucket.name,
        sourceArchiveObject: archive.name,
        entryPoint: slsFunction.properties.entryPoint,
        triggerHttp: true,
        timeout: parseInt(slsFunction.properties.timeout.replace('s', '')),
        environmentVariables: slsFunction.properties.environmentVariables,
        ingressSettings: 'ALLOW_INTERNAL_AND_GCLB',
        vpcConnector: vpcConnector.selfLink,
        vpcConnectorEgressSettings: 'PRIVATE_RANGES_ONLY',
        labels: {
            tag: config.generalTagName
        }
    });

    new gcp.cloudfunctions.FunctionIamMember(`${config.generalPrefix}-${slsFunction.name.toLowerCase()}-invoker`, {
        cloudFunction: slsFuncionDeployed.name,
        role: "roles/cloudfunctions.invoker",
        member: "allUsers",
    });
}
