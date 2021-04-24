/**
 * Created by Miguel Pazo (https://miguelpazo.com)
 */

import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

const configPulumi = new pulumi.Config();

export const region = gcp.config.region;
export const regionZone = gcp.config.zone;
export const projectName = gcp.config.project;

export const stack = pulumi.getStack();
export const generalTagName = configPulumi.get("generalTagName");
export const generalPrefix = generalTagName + '-' + stack;

export const targetDomain = configPulumi.get("targetDomain");
export const targetDomainRedirect = configPulumi.get("targetDomainRedirect");

export const vpcNetwork = configPulumi.get("vpcNetwork");
export const vpcConnectorRange = configPulumi.get("vpcConnectorRange");

export const slsServiceName = configPulumi.get("slsServiceName");
