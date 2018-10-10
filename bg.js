var combined = null;
var requests_with_potentials = [];

chrome.runtime.onMessage.addListener(
    function(message, sender, sendResponse) {
        if (message.action == "getRequests") {
            sendResponse(requests_with_potentials);
        }
        if (message.action == "getCombined") {
            sendResponse(combined);
        }
    }
);

chrome.browserAction.onClicked.addListener(
    function(){
        chrome.tabs.create({
            url: chrome.extension.getURL("main.html")
        });
    }
);

chrome.webRequest.onBeforeRequest.addListener(
    logRequest,
    {urls: ["<all_urls>"]},
    ["requestBody"]
);

fetch("combined.json")
  .then(response => response.json())
  .then(json => combined = json);

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}\/()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function deplural(str) {
    if (str === null)
        return "";
    if (str.endsWith("s")) {
        return str.substring(0, str.length - 1);
    }
    if (str.endsWith("ies")) {
        return str.substring(0, str.length - 3);
    }
    return str;
}

function logRequest(details) {
    var requestBody = null;
    var jsonRequestBody = null;

    if (details.type != "xmlhttprequest") return;

    if (analyseRequest(details) !== false) return;

    try {
        requestBody = decodeURIComponent(String.fromCharCode.apply(null, new Uint8Array(details.requestBody.raw[0].bytes)));
        jsonRequestBody = JSON.parse(requestBody);
    } catch(e) {;}

    var rgx = /^.*console\.aws\.amazon\.com\/([a-zA-Z0-9-]+)\/(.+)$/g;
    var match = rgx.exec(details.url);

    if (match && match.length > 2) {
        var service = match[1];
        var pathending = match[2];

        if (pathending === null) {
            pathending = "";
        }
        if (requestBody === null) {
            requestBody = "";
        }

        var valid_service = false;
        for (var i in combined) {
            if (service == combined[i]['endpoint_prefix'] || service == i) {
                valid_service = true;
            }
        }

        if (valid_service) {
            var potentials = [];
            console.log(details.url);
            for (var testing_service in combined) {
                for (var operation in combined[testing_service]['operations']) {
                    // Dedup here

                    var operation_name = deplural(combined[testing_service]['operations'][operation]['name']).toLowerCase();
                    if (pathending.toLowerCase().includes(operation_name) || pathending.toLowerCase().replace("get", "describe").includes(operation_name)) {
                        console.log("Potential Match: " + testing_service + "." + combined[testing_service]['operations'][operation]['name']);
                        potentials.push({
                            'service': testing_service,
                            'opid': operation,
                            'opname': combined[testing_service]['operations'][operation]['name'],
                            'foundinuri': true
                        });
                    } else if (requestBody.toLowerCase().includes(operation_name) || requestBody.toLowerCase().replace("get", "describe").includes(operation_name)) {
                        console.log("Potential Match: " + testing_service + "." + combined[testing_service]['operations'][operation]['name']);
                        potentials.push({
                            'service': testing_service,
                            'opid': operation,
                            'opname': combined[testing_service]['operations'][operation]['name'],
                            'foundinuri': false
                        });
                    }
                }
            }

            var regex = '.+' + escapeRegExp(`console.aws.amazon.com/${service}/${pathending}`) + '$'; ///
            
            requests_with_potentials.push({
                'url': details.url,
                'method': details.method,
                'potentials': potentials,
                'service': service,
                'requestBody': requestBody,
                'regex': regex
            });
            console.warn("---");
        } else {
            console.log("Non-valid service: " + service);
        }
    }
}

function getUrlValue(url, key) {
    var url = new URL(url);
    return url.searchParams.get(key);
}

/********/

var outputs = [];
var tracked_resources = [];
var blocking = false;

function analyseRequest(details) {
    var reqParams = {
        'boto3': {},
        'go': {},
        'cfn': {},
        'cli': {}
    };
    var requestBody = "";
    var jsonRequestBody = {};
    var region = 'us-west-2';

    try {
        requestBody = decodeURIComponent(String.fromCharCode.apply(null, new Uint8Array(details.requestBody.raw[0].bytes)));
        jsonRequestBody = JSON.parse(requestBody);

        // check for string objects
        for (var prop in jsonRequestBody) {
            if (typeof jsonRequestBody[prop] == "string") {
                try {
                    var parsed = JSON.parse(jsonRequestBody[prop]);
                    jsonRequestBody[prop] = parsed;
                } catch(e) {;}
            }
        }
    } catch(e) {;}

    //--CloudFormation--//

    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/cloudformation\/service\/stacks\?/g)) {
        console.log("TODO - CFN");
    }

    //--EC2--//
    
    // manual:ec2:ec2.DescribeInstances
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getMergedInstanceList\?/g)) {
        if ('filters' in jsonRequestBody) {
            reqParams.cli['--filters'] = jsonRequestBody.filters;
            reqParams.boto3['Filter'] = [];
            jsonRequestBody['filters'].forEach(filter => {
                reqParams.boto3['Filter'].push({
                    'Name': filter['name'],
                    'Values': filter['values']
                });
            });
        }
        reqParams.boto3['MaxResults'] = jsonRequestBody.count;

        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeInstances',
                'boto3': 'describe_instances',
                'cli': 'describe-instances'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribeImages
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getPrivateImageList\?/g)) {
        if (jsonRequestBody['publicAndPrivate'] != true) {
            reqParams.boto3['Owner'] = ['self'];
            reqParams.cli['--owners'] = "self";
        }

        if ('imageType' in jsonRequestBody) {
            if (jsonRequestBody['filters'] === undefined)
                jsonRequestBody['filters'] = [];
            jsonRequestBody.filters['imageType'] = jsonRequestBody.imageType;
        }
        
        if ('filters' in jsonRequestBody) {
            reqParams.cli['--filters'] = jsonRequestBody.filters;
            reqParams.boto3['Filter'] = [];
            jsonRequestBody['filters'].forEach(filter => {
                reqParams.boto3['Filter'].push({
                    'Name': filter['name'],
                    'Values': filter['values']
                });
            });
        }
        reqParams.boto3['MaxResults'] = jsonRequestBody.count;

        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeImages',
                'boto3': 'describe_images',
                'cli': 'describe-images'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribeImages
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=searchAmis\?/g)) {
        reqParams.boto3['MaxResults'] = jsonRequestBody.count;
        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeImages',
                'boto3': 'describe_images',
                'cli': 'describe-images'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribeVpcs
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getVpcs\?/g)) {
        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeVpcs',
                'boto3': 'describe_vpcs',
                'cli': 'describe-vpcs'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribeSubnets
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getSubnets\?/g)) {
        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeSubnets',
                'boto3': 'describe_subnets',
                'cli': 'describe-subnets'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribeHosts
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getSdkResources_Hosts\?/g)) {
        if ('filters' in jsonRequestBody) {
            reqParams.cli['--filters'] = jsonRequestBody.filters;
            reqParams.boto3['Filter'] = [];
            jsonRequestBody['filters'].forEach(filter => {
                reqParams.boto3['Filter'].push({
                    'Name': filter['name'],
                    'Values': filter['values']
                });
            });
        }

        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeHosts',
                'boto3': 'describe_hosts',
                'cli': 'describe-hosts'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:iam.ListInstanceProfiles
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getInstanceProfileList\?/g)) {
        outputs.push({
            'region': region,
            'service': 'iam',
            'method': {
                'api': 'ListInstanceProfiles',
                'boto3': 'list_instance_profiles',
                'cli': 'list-instance-profiles'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribeNetworkInterfaces
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getNetworkInterfaces\?/g)) {
        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeNetworkInterfaces',
                'boto3': 'describe_network_interfaces',
                'cli': 'describe-network-interfaces'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribeAvailabilityZones
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getAvailabilityZones\?/g)) {
        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeAvailabilityZones',
                'boto3': 'describe_availability_zones',
                'cli': 'describe-availability-zones'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribeSecurityGroups
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getSecurityGroups\?/g)) {
        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeSecurityGroups',
                'boto3': 'describe_security_groups',
                'cli': 'describe-security-groups'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribeKeyPairs
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getKeyPairList\?/g)) {
        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeKeyPairs',
                'boto3': 'describe_key_pairs',
                'cli': 'describe-key-pairs'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.CreateSecurityGroup
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=createSecurityGroup\?/g)) {
        reqParams.boto3['GroupDescription'] = jsonRequestBody.groupDescription;
        reqParams.boto3['GroupName'] = jsonRequestBody.groupName;
        reqParams.cli['--description'] = jsonRequestBody.groupDescription;
        reqParams.cli['--group-name'] = jsonRequestBody.groupName;
        reqParams.cfn['GroupDescription'] = jsonRequestBody.groupDescription;
        reqParams.cfn['GroupName'] = jsonRequestBody.groupName;
        if ('vpcId' in jsonRequestBody) {
            reqParams.boto3['VpcId'] = jsonRequestBody.vpcId;
            reqParams.cli['--vpc-id'] = jsonRequestBody.vpcId;
            reqParams.cfn['VpcId'] = jsonRequestBody.vpcId;
        }

        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'CreateSecurityGroup',
                'boto3': 'create_security_group',
                'cli': 'create-security-group'
            },
            'options': reqParams,
            'was_blocked': blocking
        });

        tracked_resources.push({
            'region': region,
            'service': 'ec2',
            'type': 'AWS::EC2::SecurityGroup',
            'options': reqParams,
            'was_blocked': blocking
        });

        if (blocking) {
            notifyBlocked();
            return {cancel: true};
        }

        return {};
    }

    // manual:ec2:ec2.AuthorizeSecurityGroupIngress
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=authorizeIngress\?/g)) {
        if ('groupId' in jsonRequestBody) {
            reqParams.boto3['GroupId'] = jsonRequestBody.groupId;
            reqParams.cli['--group-id'] = jsonRequestBody.groupId;
        }
        reqParams.boto3['IpPermissions'] = [];
        reqParams.cli['--ip-permissions'] = [];
        if (jsonRequestBody['ipPermissions']) {
            jsonRequestBody['ipPermissions'].forEach(ipPermission => {
                var ipRangeObjects = [];
                ipPermission['ipRangeObjects'].forEach(ipRangeObject => {
                    ipRangeObjects.push({
                        'Description': ipRangeObject['description'],
                        'CidrIp': ipRangeObject['cidrIp']
                    });
                });
                var ipv6RangeObjects = [];
                ipPermission['ipv6RangeObjects'].forEach(ipv6RangeObject => {
                    ipv6RangeObjects.push({
                        'Description': ipv6RangeObject['description'],
                        'CidrIpv6': ipv6RangeObject['CidrIpv6']
                    });
                });
                reqParams.boto3['IpPermissions'].push({
                    'IpProtocol': ipPermission['ipProtocol'],
                    'FromPort': ipPermission['fromPort'],
                    'ToPort': ipPermission['toPort'],
                    'IpRanges': ipRangeObjects,
                    'Ipv6Ranges': ipv6RangeObjects
                });
                reqParams.cli['--ip-permissions'].push({
                    'IpProtocol': ipPermission['ipProtocol'],
                    'FromPort': ipPermission['fromPort'],
                    'ToPort': ipPermission['toPort'],
                    'IpRanges': ipRangeObjects,
                    'Ipv6Ranges': ipv6RangeObjects
                });
            });
        }

        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'AuthorizeSecurityGroupIngress',
                'boto3': 'authorize_security_group_ingress',
                'cli': 'authorize-security-group-ingress'
            },
            'options': reqParams,
            'was_blocked': blocking
        });

        if (blocking) {
            notifyBlocked();
            return {cancel: true};
        }

        return {};
    }

    // manual:ec2:ec2.RunInstances
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\/elastic\/\?call\=com.amazonaws.ec2.AmazonEC2.RunInstances\?/g)) {
        reqParams.boto3['ImageId'] = jsonRequestBody.ImageId;
        reqParams.boto3['MaxCount'] = jsonRequestBody.MaxCount;
        reqParams.boto3['MinCount'] = jsonRequestBody.MinCount;
        reqParams.boto3['KeyName'] = jsonRequestBody.KeyName;
        reqParams.boto3['SecurityGroupId'] = jsonRequestBody.SecurityGroupIds;
        reqParams.boto3['InstanceType'] = jsonRequestBody.InstanceType;
        reqParams.boto3['Placement'] = jsonRequestBody.Placement;
        reqParams.boto3['Monitoring'] = jsonRequestBody.Monitoring;
        reqParams.boto3['DisableApiTermination'] = jsonRequestBody.DisableApiTermination;
        reqParams.boto3['InstanceInitiatedShutdownBehavior'] = jsonRequestBody.InstanceInitiatedShutdownBehavior;
        reqParams.boto3['CreditSpecification'] = jsonRequestBody.CreditSpecification;
        reqParams.boto3['TagSpecification'] = jsonRequestBody.TagSpecifications;
        reqParams.boto3['EbsOptimized'] = jsonRequestBody.EbsOptimized;
        reqParams.boto3['BlockDeviceMapping'] = jsonRequestBody.BlockDeviceMappings;

        reqParams.cfn['ImageId'] = jsonRequestBody.ImageId;
        reqParams.cfn['KeyName'] = jsonRequestBody.KeyName;
        reqParams.cfn['SecurityGroupIds'] = jsonRequestBody.SecurityGroupIds;
        reqParams.cfn['InstanceType'] = jsonRequestBody.InstanceType;
        if (jsonRequestBody.Placement && jsonRequestBody.Placement.Tenancy) {
            reqParams.cfn['Tenancy'] = jsonRequestBody.Placement.Tenancy;
        }
        reqParams.cfn['Monitoring'] = jsonRequestBody.Monitoring.Enabled;
        reqParams.cfn['DisableApiTermination'] = jsonRequestBody.DisableApiTermination;
        reqParams.cfn['InstanceInitiatedShutdownBehavior'] = jsonRequestBody.InstanceInitiatedShutdownBehavior;
        if (jsonRequestBody.CreditSpecification) {
            reqParams.cfn['CreditSpecification'] = {
                'CPUCredits': jsonRequestBody.CreditSpecification.CpuCredits
            }
        }
        reqParams.cfn['Tags'] = jsonRequestBody.TagSpecifications;
        reqParams.cfn['EbsOptimized'] = jsonRequestBody.EbsOptimized;
        reqParams.cfn['BlockDeviceMappings'] = jsonRequestBody.BlockDeviceMappings;

        reqParams.cli['--image-id'] = jsonRequestBody.ImageId;
        if (jsonRequestBody.MaxCount == jsonRequestBody.MinCount) {
            reqParams.cli['--count'] = jsonRequestBody.MinCount;
        } else {
            reqParams.cli['--count'] = jsonRequestBody.MinCount + ":" + jsonRequestBody.MaxCount;
        }
        reqParams.cli['--key-name'] = jsonRequestBody.KeyName;
        reqParams.cli['--security-group-ids'] = jsonRequestBody.SecurityGroupIds;
        reqParams.cli['--instance-type'] = jsonRequestBody.InstanceType;
        reqParams.cli['--placement'] = jsonRequestBody.Placement;
        reqParams.cli['--monitoring'] = jsonRequestBody.Monitoring;
        if (jsonRequestBody.DisableApiTermination === true)
            reqParams.cli['--disable-api-termination'] = null;
        else if (jsonRequestBody.DisableApiTermination === false)
            reqParams.cli['--enable-api-termination'] = null;
        reqParams.cli['--instance-initiated-shutdown-behavior'] = jsonRequestBody.InstanceInitiatedShutdownBehavior;
        reqParams.cli['--credit-specification'] = jsonRequestBody.CreditSpecification;
        reqParams.cli['--tag-specifications'] = jsonRequestBody.TagSpecifications;

        if (jsonRequestBody.EbsOptimized === true)
            reqParams.cli['--ebs-optimized'] = null;
        else if (jsonRequestBody.EbsOptimized === false)
            reqParams.cli['--no-ebs-optimized'] = null;
        reqParams.cli['--block-device-mappings'] = jsonRequestBody.BlockDeviceMappings;

        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'RunInstances',
                'boto3': 'run_instances',
                'cli': 'run-instances'
            },
            'options': reqParams,
            'was_blocked': blocking
        });

        tracked_resources.push({
            'region': region,
            'service': 'ec2',
            'type': 'AWS::EC2::Instance',
            'options': reqParams,
            'was_blocked': blocking
        });

        if (blocking) {
            notifyBlocked();
            return {cancel: true};
        }

        return {};
    }

    // manual:ec2:ec2.TerminateInstances
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=terminateInstances\?/g)) {
        reqParams.boto3['InstanceIds'] = jsonRequestBody.instanceIds;
        reqParams.cli['--instance-ids'] = jsonRequestBody.instanceIds;

        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'TerminateInstances',
                'boto3': 'terminate_instances',
                'cli': 'terminate-instances'
            },
            'options': reqParams,
            'was_blocked': blocking
        });

        if (blocking) {
            notifyBlocked();
            return {cancel: true};
        }

        return {};
    }

    // manual:ec2:ec2.DescribeLaunchTemplates
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\/elastic\/\?call\=com.amazonaws.ec2.AmazonEC2.DescribeLaunchTemplates\?/g)) {
        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeLaunchTemplates',
                'boto3': 'describe_launch_templates',
                'cli': 'describe-launch-templates'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ds.DescribeDirectories
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\/elastic\/\?call\=com.amazonaws.directoryservice.+.DescribeDirectories\?/g)) {
        outputs.push({
            'region': region,
            'service': 'ds',
            'method': {
                'api': 'DescribeDirectories',
                'boto3': 'describe_directories',
                'cli': 'describe-directories'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribePlacementGroups
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\/elastic\/\?call\=com.amazonaws.ec2.AmazonEC2.DescribePlacementGroups\?/g)) {
        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribePlacementGroups',
                'boto3': 'describe_placement_groups',
                'cli': 'describe-placement-groups'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribeSpotPriceHistory
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getCurrentSpotPrice\?/g)) {
        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeSpotPriceHistory',
                'boto3': 'describe_spot_price_history',
                'cli': 'describe-spot-price-history'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribeTags
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getTags\?/g)) {
        reqParams.boto3['Filter'] = [];
        reqParams.cli['--filter'] = [];

        if (jsonRequestBody['key']) {
            if (jsonRequestBody['key'].length > 0) {
                reqParams.boto3['Filter'].push({
                    'Name': 'key',
                    'Values': [jsonRequestBody['key']]
                });
                reqParams.cli['--filter'].push({
                    'Name': 'key',
                    'Values': [jsonRequestBody['key']]
                });
            }
        }
        if (jsonRequestBody['value']) {
            if (jsonRequestBody['value'].length > 0) {
                reqParams.boto3['Filter'].push({
                    'Name': 'value',
                    'Values': [jsonRequestBody['value']]
                });
                reqParams.cli['--filter'].push({
                    'Name': 'value',
                    'Values': [jsonRequestBody['value']]
                });
            }
        }
        if (reqParams.boto3['Filter'].length == 0) {
            delete reqParams.boto3['Filter'];
            delete reqParams.cli['--filter'];
        }

        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeTags',
                'boto3': 'describe_tags',
                'cli': 'describe-tags'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:ec2:ec2.DescribeInstanceAttribute
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/ec2\/ecb\?call\=getTerminationProtection\?/g)) {
        reqParams.boto3['InstanceId'] = jsonRequestBody.instanceId;
        reqParams.boto3['Attribute'] = "disableApiTermination";
        reqParams.cli['--instance-id'] = jsonRequestBody.instanceId;
        reqParams.cli['--attribute'] = "disableApiTermination";

        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeInstanceAttribute',
                'boto3': 'describe_instance_attribute',
                'cli': 'describe-instance-attribute'
            },
            'options': reqParams
        });

        return {};
    }

    //--S3--//

    // manual:s3:s3.CreateBucket
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "CreateBucket") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";
        reqParams.cfn['BucketName'] = jsonRequestBody.path;

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'CreateBucket',
                'boto3': 'create_bucket',
                'cli': 'create-bucket'
            },
            'options': reqParams
        });

        tracked_resources.push({
            'region': region,
            'service': 's3',
            'type': 'AWS::S3::Bucket',
            'options': reqParams,
            'was_blocked': blocking
        });

        return {};
    }
    
    // manual:s3:s3.PutBucketVersioning
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "PutBucketVersioning") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";
        reqParams = addToParamsFromXml(reqParams, jsonRequestBody.contentString);

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'PutBucketVersioning',
                'boto3': 'put_bucket_versioning',
                'cli': 'put-bucket-versioning'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.PutBucketMetricsConfiguration
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "PutBucketMetrics") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";
        reqParams = addToParamsFromXml(reqParams, jsonRequestBody.contentString);

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'PutBucketMetricsConfiguration',
                'boto3': 'put_bucket_metrics_configuration',
                'cli': 'put-bucket-metrics-configuration'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.PutBucketTagging
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "PutBucketTagging") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";
        reqParams = addToParamsFromXml(reqParams, jsonRequestBody.contentString);

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'PutBucketTagging',
                'boto3': 'put_bucket_tagging',
                'cli': 'put-bucket-tagging'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.PutBucketAcl
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "PutBucketAcl") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";
        reqParams = addToParamsFromXml(reqParams, jsonRequestBody.contentString);

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'PutBucketAcl',
                'boto3': 'put_bucket_acl',
                'cli': 'put-bucket-acl'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.PutBucketLogging
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "PutBucketLogging") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";
        reqParams = addToParamsFromXml(reqParams, jsonRequestBody.contentString);

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'PutBucketLogging',
                'boto3': 'put_bucket_logging',
                'cli': 'put-bucket-logging'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.DeleteBucket
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "DeleteBucket") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'DeleteBucket',
                'boto3': 'delete_bucket',
                'cli': 'delete-bucket'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.ListObjects
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "ListObjects") {
        reqParams.boto3['BucketName'] = jsonRequestBody.path;
        reqParams.boto3['Prefix'] = jsonRequestBody.params.prefix;
        reqParams.cli['_'] = [
            `s3://${jsonRequestBody.path}/${jsonRequestBody.params.prefix}`
        ]

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'ListObjects',
                'boto3': 'list_objects',
                'cli': 'ls'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketVersioning
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketVersioning") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketVersioning',
                'boto3': 'get_bucket_versioning',
                'cli': 'get-bucket-versioning'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketLogging
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketLogging") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketLogging',
                'boto3': 'get_bucket_logging',
                'cli': 'get-bucket-logging'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketTagging
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketTagging") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketTagging',
                'boto3': 'get_bucket_tagging',
                'cli': 'get-bucket-tagging'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketNotificationConfiguration
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketNotification") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketNotificationConfiguration',
                'boto3': 'get_bucket_notification_configuration',
                'cli': 'get-bucket-notification-configuration'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketWebsite
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketWebsite") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketWebsite',
                'boto3': 'get_bucket_website',
                'cli': 'get-bucket-website'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketRequestPayment
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketRequestPayment") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketRequestPayment',
                'boto3': 'get_bucket_request_payment',
                'cli': 'get-bucket-request-payment'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketAccelerateConfiguration
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketAccelerate") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketAccelerateConfiguration',
                'boto3': 'get_bucket_accelerate_configuration',
                'cli': 'get-bucket-accelerate-configuration'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketEncryption
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketDefaultEncryption") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketEncryption',
                'boto3': 'get_bucket_encryption',
                'cli': 'get-bucket-encryption'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketReplication
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketReplication") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketReplication',
                'boto3': 'get_bucket_replication',
                'cli': 'get-bucket-replication'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketMetricsConfiguration
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketMetrics") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketMetricsConfiguration',
                'boto3': 'get_bucket_metrics_configuration',
                'cli': 'get-bucket-metrics-configuration'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketAnalyticsConfiguration
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketAnalytics") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketAnalyticsConfiguration',
                'boto3': 'get_bucket_analytics_configuration',
                'cli': 'get-bucket-analytics-configuration'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketLifecycleConfiguration
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetLifecycleConfiguration") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketLifecycleConfiguration',
                'boto3': 'get_bucket_lifecycle_configuration',
                'cli': 'get-bucket-lifecycle-configuration'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:s3:s3.GetBucketCORS
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketCORS") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketCORS',
                'boto3': 'get_bucket_cors',
                'cli': 'get-bucket-cors'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketPolicy
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketPolicy") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketPolicy',
                'boto3': 'get_bucket_policy',
                'cli': 'get-bucket-policy'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.GetBucketAcl
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "GetBucketAcl") {
        reqParams.boto3['Bucket'] = jsonRequestBody.path;
        reqParams.cli['--bucket'] = jsonRequestBody.path;
        reqParams.cli['_service'] = "s3api";

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'GetBucketAcl',
                'boto3': 'get_bucket_acl',
                'cli': 'get-bucket-acl'
            },
            'options': reqParams
        });

        return {};
    }
    
    // manual:s3:s3.ListBuckets
    if (details.url.match(/.+console\.aws\.amazon\.com\/s3\/proxy$/g) && jsonRequestBody.operation == "ListAllMyBuckets") {
        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'ListBuckets',
                'boto3': 'list_buckets',
                'cli': 'ls'
            },
            'options': reqParams
        });

        return {};
    }

    // manual:s3:cloudtrail.DescribeTrails
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/s3\/cloudtrail-proxy$/g) && jsonRequestBody.operation == "DescribeTrails") {
        reqParams.boto3['includeShadowTrails'] = jsonRequestBody.content.includeShadowTrails;
        reqParams.boto3['trailNameList'] = jsonRequestBody.content.trailNameList;
        if (jsonRequestBody.content.includeShadowTrails === true)
            reqParams.cli['--include-shadow-trails'] = null;
        else if (jsonRequestBody.content.includeShadowTrails === true)
            reqParams.cli['--no-include-shadow-trails'] = null;
        reqParams.cli['--trail-name-list'] = jsonRequestBody.content.trailNameList;
        

        outputs.push({
            'region': region,
            'service': 'cloudtrail',
            'method': {
                'api': 'DescribeTrails',
                'boto3': 'describe_trails',
                'cli': 'describe-trails'
            },
            'options': reqParams
        });

        return {};
    }

    /* Start Auto */

    // autogen:cloud9:cloud9.DescribeEnvironmentMemberships
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/cloud9\/api\/cloud9$/g) && jsonRequestBody.operation == "describeEnvironmentMemberships" && jsonRequestBody.method == "POST") {
        reqParams.boto3['Permissions'] = jsonRequestBody.contentString.permissions;
        reqParams.cli['--permissions'] = jsonRequestBody.contentString.permissions;
        reqParams.boto3['MaxResults'] = jsonRequestBody.contentString.maxResults;
        reqParams.cli['--max-results'] = jsonRequestBody.contentString.maxResults;

        outputs.push({
            'region': region,
            'service': 'cloud9',
            'method': {
                'api': 'DescribeEnvironmentMemberships',
                'boto3': 'describe_environment_memberships',
                'cli': 'describe-environment-memberships'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloud9:cloud9.DescribeEnvironments
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/cloud9\/api\/cloud9$/g) && jsonRequestBody.operation == "describeEnvironments" && jsonRequestBody.method == "POST") {
        reqParams.boto3['EnvironmentIds'] = jsonRequestBody.contentString.environmentIds;
        reqParams.cli['--environment-ids'] = jsonRequestBody.contentString.environmentIds;

        outputs.push({
            'region': region,
            'service': 'cloud9',
            'method': {
                'api': 'DescribeEnvironments',
                'boto3': 'describe_environments',
                'cli': 'describe-environments'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloud9:cloud9.ListEnvironments
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/cloud9\/api\/cloud9$/g) && jsonRequestBody.operation == "listEnvironments" && jsonRequestBody.method == "POST") {
        reqParams.boto3['MaxResults'] = jsonRequestBody.contentString.maxResults;
        reqParams.cli['--max-results'] = jsonRequestBody.contentString.maxResults;

        outputs.push({
            'region': region,
            'service': 'cloud9',
            'method': {
                'api': 'ListEnvironments',
                'boto3': 'list_environments',
                'cli': 'list-environments'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloud9:cloud9.UpdateEnvironment
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/cloud9\/api\/cloud9$/g) && jsonRequestBody.operation == "describeEC2Remote" && jsonRequestBody.method == "POST" && jsonRequestBody.operation == "updateEnvironment" && jsonRequestBody.method == "POST") {
        reqParams.boto3['EnvironmentId'] = jsonRequestBody.contentString.environmentId;
        reqParams.cli['--environment-id'] = jsonRequestBody.contentString.environmentId;
        reqParams.boto3['Name'] = jsonRequestBody.contentString.name;
        reqParams.cli['--name'] = jsonRequestBody.contentString.name;
        reqParams.boto3['Description'] = jsonRequestBody.contentString.description;
        reqParams.cli['--description'] = jsonRequestBody.contentString.description;

        outputs.push({
            'region': region,
            'service': 'cloud9',
            'method': {
                'api': 'UpdateEnvironment',
                'boto3': 'update_environment',
                'cli': 'update-environment'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloud9:ec2.DescribeVpcs
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/cloud9\/api\/ec2$/g) && jsonRequestBody.operation == "describeVpcs" && jsonRequestBody.method == "POST") {

        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeVpcs',
                'boto3': 'describe_vpcs',
                'cli': 'describe-vpcs'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloud9:ec2.DescribeSubnets
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/cloud9\/api\/ec2$/g) && jsonRequestBody.operation == "describeSubnets" && jsonRequestBody.method == "POST") {

        outputs.push({
            'region': region,
            'service': 'ec2',
            'method': {
                'api': 'DescribeSubnets',
                'boto3': 'describe_subnets',
                'cli': 'describe-subnets'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloud9:cloud9.CreateEnvironmentEC2
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/cloud9\/api\/cloud9$/g) && jsonRequestBody.operation == "createEnvironmentEC2" && jsonRequestBody.method == "POST") {
        reqParams.boto3['Name'] = jsonRequestBody.contentString.name;
        reqParams.cli['--name'] = jsonRequestBody.contentString.name;
        reqParams.boto3['Description'] = jsonRequestBody.contentString.description;
        reqParams.cli['--description'] = jsonRequestBody.contentString.description;
        reqParams.boto3['InstanceType'] = jsonRequestBody.contentString.instanceType;
        reqParams.cli['--instance-type'] = jsonRequestBody.contentString.instanceType;
        reqParams.boto3['AutomaticStopTimeMinutes'] = jsonRequestBody.contentString.automaticStopTimeMinutes;
        reqParams.cli['--automatic-stop-time-minutes'] = jsonRequestBody.contentString.automaticStopTimeMinutes;
        reqParams.boto3['SubnetId'] = jsonRequestBody.contentString.subnetId;
        reqParams.cli['--subnet-id'] = jsonRequestBody.contentString.subnetId;
        reqParams.boto3['ClientRequestToken'] = jsonRequestBody.contentString.clientRequestToken;
        reqParams.cli['--client-request-token'] = jsonRequestBody.contentString.clientRequestToken;

        outputs.push({
            'region': region,
            'service': 'cloud9',
            'method': {
                'api': 'CreateEnvironmentEC2',
                'boto3': 'create_environment_ec2',
                'cli': 'create-environment-ec2'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloud9:cloud9.DeleteEnvironment
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/cloud9\/api\/cloud9$/g) && jsonRequestBody.operation == "deleteEnvironment" && jsonRequestBody.method == "POST") {
        reqParams.boto3['EnvironmentId'] = jsonRequestBody.contentString.environmentId;
        reqParams.cli['--environment-id'] = jsonRequestBody.contentString.environmentId;

        outputs.push({
            'region': region,
            'service': 'cloud9',
            'method': {
                'api': 'DeleteEnvironment',
                'boto3': 'delete_environment',
                'cli': 'delete-environment'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:medialive:medialive.ListInputSecurityGroups
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/medialive\/api\/inputSecurityGroups$/g) && jsonRequestBody.method == "GET") {

        outputs.push({
            'region': region,
            'service': 'medialive',
            'method': {
                'api': 'ListInputSecurityGroups',
                'boto3': 'list_input_security_groups',
                'cli': 'list-input-security-groups'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:medialive:medialive.ListChannels
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/medialive\/api\/channels$/g) && jsonRequestBody.method == "GET") {

        outputs.push({
            'region': region,
            'service': 'medialive',
            'method': {
                'api': 'ListChannels',
                'boto3': 'list_channels',
                'cli': 'list-channels'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:medialive:medialive.CreateInputSecurityGroup
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/medialive\/api\/inputSecurityGroups$/g) && jsonRequestBody.method == "GET" && jsonRequestBody.method == "POST") {
        reqParams.boto3['WhitelistRules'] = jsonRequestBody.contentString.whitelistRules;
        reqParams.cli['--whitelist-rules'] = jsonRequestBody.contentString.whitelistRules;

        outputs.push({
            'region': region,
            'service': 'medialive',
            'method': {
                'api': 'CreateInputSecurityGroup',
                'boto3': 'create_input_security_group',
                'cli': 'create-input-security-group'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:medialive:ssm.GetParametersByPath
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/medialive\/api\/ssm$/g) && jsonRequestBody.operation == "getParametersByPath" && jsonRequestBody.method == "POST") {
        reqParams.boto3['Path'] = jsonRequestBody.contentString.Path;
        reqParams.cli['--path'] = jsonRequestBody.contentString.Path;

        outputs.push({
            'region': region,
            'service': 'ssm',
            'method': {
                'api': 'GetParametersByPath',
                'boto3': 'get_parameters_by_path',
                'cli': 'get-parameters-by-path'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:medialive:iam.ListRoles
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/medialive\/api\/iam$/g) && jsonRequestBody.operation == "listRoles") {

        outputs.push({
            'region': region,
            'service': 'iam',
            'method': {
                'api': 'ListRoles',
                'boto3': 'list_roles',
                'cli': 'list-roles'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:medialive:iam.GetRolePolicy
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/medialive\/api\/iam$/g) && jsonRequestBody.operation == "getRolePolicy") {

        outputs.push({
            'region': region,
            'service': 'iam',
            'method': {
                'api': 'GetRolePolicy',
                'boto3': 'get_role_policy',
                'cli': 'get-role-policy'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:medialive:medialive.CreateChannel
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/medialive\/api\/channels$/g) && jsonRequestBody.operation == "createChannels" && jsonRequestBody.method == "POST") {
        reqParams.boto3['Name'] = jsonRequestBody.contentString.name;
        reqParams.cli['--name'] = jsonRequestBody.contentString.name;
        reqParams.boto3['InputAttachments'] = jsonRequestBody.contentString.inputAttachments;
        reqParams.cli['--input-attachments'] = jsonRequestBody.contentString.inputAttachments;
        reqParams.boto3['InputSpecification'] = jsonRequestBody.contentString.inputSpecification;
        reqParams.cli['--input-specification'] = jsonRequestBody.contentString.inputSpecification;
        reqParams.boto3['Destinations'] = jsonRequestBody.contentString.destinations;
        reqParams.cli['--destinations'] = jsonRequestBody.contentString.destinations;
        reqParams.boto3['EncoderSettings'] = jsonRequestBody.contentString.encoderSettings;
        reqParams.cli['--encoder-settings'] = jsonRequestBody.contentString.encoderSettings;
        reqParams.boto3['RequestId'] = jsonRequestBody.contentString.requestId;
        reqParams.cli['--request-id'] = jsonRequestBody.contentString.requestId;
        reqParams.boto3['LogLevel'] = jsonRequestBody.contentString.logLevel;
        reqParams.cli['--log-level'] = jsonRequestBody.contentString.logLevel;
        reqParams.boto3['RoleArn'] = jsonRequestBody.contentString.roleArn;
        reqParams.cli['--role-arn'] = jsonRequestBody.contentString.roleArn;

        outputs.push({
            'region': region,
            'service': 'medialive',
            'method': {
                'api': 'CreateChannel',
                'boto3': 'create_channel',
                'cli': 'create-channel'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:efs:efs.DescribeFileSystems
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/efs\/ajax\/api\?region=.+&type=describeFileSystems$/g)) {

        outputs.push({
            'region': region,
            'service': 'efs',
            'method': {
                'api': 'DescribeFileSystems',
                'boto3': 'describe_file_systems',
                'cli': 'describe-file-systems'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:efs:kms.ListKeys
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/efs\/ajax\/api\?region=.+&type=listKeys$/g)) {

        outputs.push({
            'region': region,
            'service': 'kms',
            'method': {
                'api': 'ListKeys',
                'boto3': 'list_keys',
                'cli': 'list-keys'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:efs:kms.DescribeKey
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/efs\/ajax\/api\?region=.+&type=describeKey$/g)) {
        reqParams.boto3['KeyId'] = jsonRequestBody.kmsKeyId;
        reqParams.cli['--key-id'] = jsonRequestBody.kmsKeyId;

        outputs.push({
            'region': region,
            'service': 'kms',
            'method': {
                'api': 'DescribeKey',
                'boto3': 'describe_key',
                'cli': 'describe-key'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:efs:efs.CreateFileSystem
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/efs\/ajax\/api\?region=.+&type=createFileSystem$/g)) {
        reqParams.boto3['PerformanceMode'] = jsonRequestBody.performanceMode;
        reqParams.cli['--performance-mode'] = jsonRequestBody.performanceMode;
        reqParams.boto3['Encrypted'] = jsonRequestBody.encrypted;
        reqParams.cli['--encrypted'] = jsonRequestBody.encrypted;
        reqParams.boto3['KmsKeyId'] = jsonRequestBody.kmsKeyId;
        reqParams.cli['--kms-key-id'] = jsonRequestBody.kmsKeyId;
        reqParams.boto3['ThroughputMode'] = jsonRequestBody.throughputMode;
        reqParams.cli['--throughput-mode'] = jsonRequestBody.throughputMode;
        reqParams.boto3['ProvisionedThroughputInMibps'] = jsonRequestBody.provisionedThroughputInMibps;
        reqParams.cli['--provisioned-throughput-in-mibps'] = jsonRequestBody.provisionedThroughputInMibps;

        reqParams.cfn['PerformanceMode'] = jsonRequestBody.performanceMode;
        reqParams.cfn['Encrypted'] = jsonRequestBody.encrypted;
        reqParams.cfn['KmsKeyId'] = jsonRequestBody.kmsKeyId;
        reqParams.cfn['ThroughputMode'] = jsonRequestBody.throughputMode;
        reqParams.cfn['ProvisionedThroughputInMibps'] = jsonRequestBody.provisionedThroughputInMibps;

        outputs.push({
            'region': region,
            'service': 'efs',
            'method': {
                'api': 'CreateFileSystem',
                'boto3': 'create_file_system',
                'cli': 'create-file-system'
            },
            'options': reqParams
        });

        tracked_resources.push({
            'region': region,
            'service': 'efs',
            'type': 'AWS::EFS::FileSystem',
            'options': reqParams,
            'was_blocked': blocking
        });
        
        return {};
    }

    // autogen:efs:efs.CreateMountTarget
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/efs\/ajax\/api\?region=.+&type=createMountTarget$/g)) {
        reqParams.boto3['FileSystemId'] = jsonRequestBody.fileSystemId;
        reqParams.cli['--file-system-id'] = jsonRequestBody.fileSystemId;
        reqParams.boto3['SubnetId'] = jsonRequestBody.mountTargetConfig.subnetId;
        reqParams.cli['--subnet-id'] = jsonRequestBody.mountTargetConfig.subnetId;
        reqParams.boto3['SecurityGroups'] = jsonRequestBody.mountTargetConfig.securityGroups;
        reqParams.cli['--security-groups'] = jsonRequestBody.mountTargetConfig.securityGroups;

        reqParams.cfn['FileSystemId'] = jsonRequestBody.fileSystemId;
        reqParams.cfn['SubnetId'] = jsonRequestBody.mountTargetConfig.subnetId;
        reqParams.cfn['SecurityGroups'] = jsonRequestBody.mountTargetConfig.securityGroups;

        outputs.push({
            'region': region,
            'service': 'efs',
            'method': {
                'api': 'CreateMountTarget',
                'boto3': 'create_mount_target',
                'cli': 'create-mount-target'
            },
            'options': reqParams
        });

        tracked_resources.push({
            'region': region,
            'service': 'efs',
            'type': 'AWS::EFS::MountTarget',
            'options': reqParams,
            'was_blocked': blocking
        });
        
        return {};
    }

    // autogen:efs:efs.DescribeMountTargets
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/efs\/ajax\/api\?region=.+&type=describeMountTargets$/g)) {
        reqParams.boto3['FileSystemId'] = jsonRequestBody.fileSystemId;
        reqParams.cli['--file-system-id'] = jsonRequestBody.fileSystemId;

        outputs.push({
            'region': region,
            'service': 'efs',
            'method': {
                'api': 'DescribeMountTargets',
                'boto3': 'describe_mount_targets',
                'cli': 'describe-mount-targets'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:efs:efs.DescribeTags
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/efs\/ajax\/api\?region=.+&type=describeTags$/g)) {
        reqParams.boto3['FileSystemId'] = jsonRequestBody.fileSystemId;
        reqParams.cli['--file-system-id'] = jsonRequestBody.fileSystemId;

        outputs.push({
            'region': region,
            'service': 'efs',
            'method': {
                'api': 'DescribeTags',
                'boto3': 'describe_tags',
                'cli': 'describe-tags'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:efs:efs.UpdateFileSystem
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/efs\/ajax\/api\?region=.+&type=modifyThroughputMode$/g)) {
        reqParams.boto3['FileSystemId'] = jsonRequestBody.fileSystemId;
        reqParams.cli['--file-system-id'] = jsonRequestBody.fileSystemId;
        reqParams.boto3['ThroughputMode'] = jsonRequestBody.throughputMode;
        reqParams.cli['--throughput-mode'] = jsonRequestBody.throughputMode;
        reqParams.boto3['ProvisionedThroughputInMibps'] = jsonRequestBody.provisionedThroughputInMibps;
        reqParams.cli['--provisioned-throughput-in-mibps'] = jsonRequestBody.provisionedThroughputInMibps;

        outputs.push({
            'region': region,
            'service': 'efs',
            'method': {
                'api': 'UpdateFileSystem',
                'boto3': 'update_file_system',
                'cli': 'update-file-system'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:efs:efs.DeleteMountTarget
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/efs\/ajax\/api\?region=.+&type=deleteMountTarget$/g)) {
        reqParams.boto3['MountTargetId'] = jsonRequestBody.mountTargetId;
        reqParams.cli['--mount-target-id'] = jsonRequestBody.mountTargetId;

        outputs.push({
            'region': region,
            'service': 'efs',
            'method': {
                'api': 'DeleteMountTarget',
                'boto3': 'delete_mount_target',
                'cli': 'delete-mount-target'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:efs:efs.DeleteFileSystem
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/efs\/ajax\/api\?region=.+&type=deleteFileSystem$/g)) {
        reqParams.boto3['FileSystemId'] = jsonRequestBody.fileSystemId;
        reqParams.cli['--file-system-id'] = jsonRequestBody.fileSystemId;

        outputs.push({
            'region': region,
            'service': 'efs',
            'method': {
                'api': 'DeleteFileSystem',
                'boto3': 'delete_file_system',
                'cli': 'delete-file-system'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloudtrail:cloudtrail.GetEventSelectors
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/cloudtrail\/service\/getEventSelectors\?/g)) {
        reqParams.boto3['TrailName'] = getUrlValue(details.url, 'trailArn');
        reqParams.cli['--trail-name'] = getUrlValue(details.url, 'trailArn');

        outputs.push({
            'region': region,
            'service': 'cloudtrail',
            'method': {
                'api': 'GetEventSelectors',
                'boto3': 'get_event_selectors',
                'cli': 'get-event-selectors'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloudtrail:cloudtrail.DescribeTrails
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/cloudtrail\/service\/resources\/trails\?/g)) {
        reqParams.boto3['IncludeShadowTrails'] = getUrlValue(details.url, 'includeShadowTrails');
        reqParams.cli['--include-shadow-trails'] = getUrlValue(details.url, 'includeShadowTrails');

        outputs.push({
            'region': region,
            'service': 'cloudtrail',
            'method': {
                'api': 'DescribeTrails',
                'boto3': 'describe_trails',
                'cli': 'describe-trails'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloudtrail:cloudtrail.LookupEvents
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/cloudtrail\/service\/lookupEvents\?/g)) {
        reqParams.boto3['EndTime'] = getUrlValue(details.url, 'endTime');
        reqParams.cli['--end-time'] = getUrlValue(details.url, 'endTime');
        reqParams.boto3['StartTime'] = getUrlValue(details.url, 'startTime');
        reqParams.cli['--start-time'] = getUrlValue(details.url, 'startTime');

        outputs.push({
            'region': region,
            'service': 'cloudtrail',
            'method': {
                'api': 'LookupEvents',
                'boto3': 'lookup_events',
                'cli': 'lookup-events'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloudtrail:sns.ListTopics
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/cloudtrail\/service\/getSnsTopicNameToArnMapByRegion\?/g)) {

        outputs.push({
            'region': region,
            'service': 'sns',
            'method': {
                'api': 'ListTopics',
                'boto3': 'list_topics',
                'cli': 'list-topics'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloudtrail:lambda.ListFunctions
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/cloudtrail\/service\/listLambdaFunctions\?/g)) {

        outputs.push({
            'region': region,
            'service': 'lambda',
            'method': {
                'api': 'ListFunctions',
                'boto3': 'list_functions',
                'cli': 'list-functions'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloudtrail:cloudtrail.CreateTrail
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/cloudtrail\/service\/subscribe\?/g)) {
        reqParams.boto3['Name'] = getUrlValue(details.url, 'configName');
        reqParams.cli['--name'] = getUrlValue(details.url, 'configName');
        reqParams.boto3['IncludeGlobalServiceEvents'] = getUrlValue(details.url, 'isIncludeGlobalServiceEvents');
        reqParams.cli['--include-global-service-events'] = getUrlValue(details.url, 'isIncludeGlobalServiceEvents');
        reqParams.boto3['IsMultiRegionTrail'] = getUrlValue(details.url, 'isMultiRegionTrail');
        reqParams.cli['--is-multi-region-trail'] = getUrlValue(details.url, 'isMultiRegionTrail');
        reqParams.boto3['KmsKeyId'] = getUrlValue(details.url, 'kmsKeyId');
        reqParams.cli['--kms-key-id'] = getUrlValue(details.url, 'kmsKeyId');
        reqParams.boto3['EnableLogFileValidation'] = getUrlValue(details.url, 'logFileValidation');
        reqParams.cli['--enable-log-file-validation'] = getUrlValue(details.url, 'logFileValidation');
        reqParams.boto3['S3BucketName'] = getUrlValue(details.url, 's3BucketName');
        reqParams.cli['--s3-bucket-name'] = getUrlValue(details.url, 's3BucketName');
        reqParams.boto3['S3KeyPrefix'] = getUrlValue(details.url, 's3KeyPrefix');
        reqParams.cli['--s3-key-prefix'] = getUrlValue(details.url, 's3KeyPrefix');
        reqParams.boto3['SnsTopicName'] = getUrlValue(details.url, 'snsTopicArn');
        reqParams.cli['--sns-topic-name'] = getUrlValue(details.url, 'snsTopicArn');

        outputs.push({
            'region': region,
            'service': 'cloudtrail',
            'method': {
                'api': 'CreateTrail',
                'boto3': 'create_trail',
                'cli': 'create-trail'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloudtrail:cloudtrail.GetTrailStatus
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/cloudtrail\/service\/resources\/status\?/g)) {
        reqParams.boto3['Name'] = getUrlValue(details.url, 'trailArn');
        reqParams.cli['--name'] = getUrlValue(details.url, 'trailArn');

        outputs.push({
            'region': region,
            'service': 'cloudtrail',
            'method': {
                'api': 'GetTrailStatus',
                'boto3': 'get_trail_status',
                'cli': 'get-trail-status'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:cloudtrail:cloudtrail.ListTags
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/cloudtrail\/service\/listTags\?/g)) {
        reqParams.boto3['ResourceIdList'] = [getUrlValue(details.url, 'trailArn')];
        reqParams.cli['--resource-id-list'] = [getUrlValue(details.url, 'trailArn')];

        outputs.push({
            'region': region,
            'service': 'cloudtrail',
            'method': {
                'api': 'ListTags',
                'boto3': 'list_tags',
                'cli': 'list-tags'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:config:config.DescribePendingAggregationRequests
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/config\/service\/aggregationAuthorization\/describePendingAggregationRequests\?/g)) {

        outputs.push({
            'region': region,
            'service': 'config',
            'method': {
                'api': 'DescribePendingAggregationRequests',
                'boto3': 'describe_pending_aggregation_requests',
                'cli': 'describe-pending-aggregation-requests'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:config:config.DescribeConfigurationRecorders
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/config\/service\/listConfigurationRecorders\?/g)) {

        outputs.push({
            'region': region,
            'service': 'config',
            'method': {
                'api': 'DescribeConfigurationRecorders',
                'boto3': 'describe_configuration_recorders',
                'cli': 'describe-configuration-recorders'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:config:config.DescribeDeliveryChannels
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/config\/service\/listDeliveryChannels\?/g)) {

        outputs.push({
            'region': region,
            'service': 'config',
            'method': {
                'api': 'DescribeDeliveryChannels',
                'boto3': 'describe_delivery_channels',
                'cli': 'describe-delivery-channels'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:config:iam.ListRoles
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/config\/service\/iam\/listRoles\?/g)) {

        outputs.push({
            'region': region,
            'service': 'iam',
            'method': {
                'api': 'ListRoles',
                'boto3': 'list_roles',
                'cli': 'list-roles'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:config:s3.ListBuckets
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/config\/service\/listS3Buckets\?/g)) {

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'ListBuckets',
                'boto3': 'list_buckets',
                'cli': 'list-buckets'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:config:sns.ListTopics
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/config\/service\/listSnsTopics\?/g)) {

        outputs.push({
            'region': region,
            'service': 'sns',
            'method': {
                'api': 'ListTopics',
                'boto3': 'list_topics',
                'cli': 'list-topics'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:config:iam.CreateServiceLinkedRole
    if (details.method == "GET" && details.url.match(/.+console\.aws\.amazon\.com\/config\/service\/createServiceLinkedRole\?/g)) {
        reqParams.boto3['AWSServiceName'] = 'elasticbeanstalk.amazonaws.com';
        reqParams.cli['--aws-service-name'] = 'elasticbeanstalk.amazonaws.com';

        outputs.push({
            'region': region,
            'service': 'iam',
            'method': {
                'api': 'CreateServiceLinkedRole',
                'boto3': 'create_service_linked_role',
                'cli': 'create-service-linked-role'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:config:s3.CreateBucket
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/config\/service\/createS3BucketForConfiguration\?/g)) {
        reqParams.boto3['Bucket'] = jsonRequestBody.s3BucketName;
        reqParams.cli['--bucket'] = jsonRequestBody.s3BucketName;

        outputs.push({
            'region': region,
            'service': 's3',
            'method': {
                'api': 'CreateBucket',
                'boto3': 'create_bucket',
                'cli': 'create-bucket'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.ListDetectors
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "ListDetectors" && jsonRequestBody.method == "GET") {

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'ListDetectors',
                'boto3': 'list_detectors',
                'cli': 'list-detectors'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.GetInvitationsCount
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "GetInvitationsCount" && jsonRequestBody.method == "GET") {

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'GetInvitationsCount',
                'boto3': 'get_invitations_count',
                'cli': 'get-invitations-count'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.CreateDetector
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "CreateDetector" && jsonRequestBody.method == "POST") {
        reqParams.boto3['Enable'] = jsonRequestBody.contentString.enable;
        reqParams.cli['--enable'] = jsonRequestBody.contentString.enable;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'CreateDetector',
                'boto3': 'create_detector',
                'cli': 'create-detector'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.ListFindings
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "ListFindings" && jsonRequestBody.method == "POST") {
        reqParams.boto3['FindingCriteria'] = jsonRequestBody.contentString.findingCriteria;
        reqParams.cli['--finding-criteria'] = jsonRequestBody.contentString.findingCriteria;
        reqParams.boto3['SortCriteria'] = jsonRequestBody.contentString.sortCriteria;
        reqParams.cli['--sort-criteria'] = jsonRequestBody.contentString.sortCriteria;
        reqParams.boto3['MaxResults'] = jsonRequestBody.contentString.maxResults;
        reqParams.cli['--max-items'] = jsonRequestBody.contentString.maxResults;
        reqParams.boto3['NextToken'] = jsonRequestBody.contentString.nextToken;
        reqParams.cli['--next-token'] = jsonRequestBody.contentString.nextToken;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'ListFindings',
                'boto3': 'list_findings',
                'cli': 'list-findings'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.GetMasterAccount
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "GetMasterAccount" && jsonRequestBody.method == "GET") {

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'GetMasterAccount',
                'boto3': 'get_master_account',
                'cli': 'get-master-account'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.ListMembers
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "ListMembers" && jsonRequestBody.method == "GET") {
        reqParams.boto3['MaxResults'] = jsonRequestBody.params.maxResults;
        reqParams.cli['--max-items'] = jsonRequestBody.params.maxResults;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'ListMembers',
                'boto3': 'list_members',
                'cli': 'list-members'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.GetDetector
    // modified for path split
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "GetDetector" && jsonRequestBody.method == "GET") {
        reqParams.boto3['DetectorId'] = jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'GetDetector',
                'boto3': 'get_detector',
                'cli': 'get-detector'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.GetFindingsStatistics
    // modified for path split
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "GetFindingsStatistics" && jsonRequestBody.method == "POST") {
        reqParams.boto3['DetectorId'] = jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];
        reqParams.boto3['FindingCriteria'] = jsonRequestBody.contentString.findingCriteria;
        reqParams.cli['--finding-criteria'] = jsonRequestBody.contentString.findingCriteria;
        reqParams.boto3['FindingStatisticTypes'] = jsonRequestBody.contentString.findingStatisticTypes;
        reqParams.cli['--finding-statistic-types'] = jsonRequestBody.contentString.findingStatisticTypes;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'GetFindingsStatistics',
                'boto3': 'get_findings_statistics',
                'cli': 'get-findings-statistics'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.ListFilters
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "ListFilters" && jsonRequestBody.method == "GET") {
        reqParams.boto3['MaxResults'] = jsonRequestBody.params.maxResults;
        reqParams.cli['--max-items'] = jsonRequestBody.params.maxResults;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'ListFilters',
                'boto3': 'list_filters',
                'cli': 'list-filters'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.CreateMembers
    // modified for path split
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "CreateMembers" && jsonRequestBody.method == "POST") {
        reqParams.boto3['DetectorId'] = jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];
        reqParams.boto3['AccountDetails'] = jsonRequestBody.contentString.accountDetails;
        reqParams.cli['--account-details'] = jsonRequestBody.contentString.accountDetails;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'CreateMembers',
                'boto3': 'create_members',
                'cli': 'create-members'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.DeleteMembers
    // modified for path split
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "DeleteMembers" && jsonRequestBody.method == "POST") {
        reqParams.boto3['DetectorId'] = jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];
        reqParams.boto3['AccountIds'] = jsonRequestBody.contentString.accountIds;
        reqParams.cli['--account-ids'] = jsonRequestBody.contentString.accountIds;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'DeleteMembers',
                'boto3': 'delete_members',
                'cli': 'delete-members'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.ListIPSets
    // modified for path split
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "ListIPSets" && jsonRequestBody.method == "GET") {
        reqParams.boto3['DetectorId'] = jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];
        reqParams.boto3['MaxResults'] = jsonRequestBody.params.maxResults;
        reqParams.cli['--max-items'] = jsonRequestBody.params.maxResults;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'ListIPSets',
                'boto3': 'list_ip_sets',
                'cli': 'list-ip-sets'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.ListThreatIntelSets
    // modified for path split
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "ListThreatIntelSets" && jsonRequestBody.method == "GET") {
        reqParams.boto3['DetectorId'] = jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];
        reqParams.boto3['MaxResults'] = jsonRequestBody.params.maxResults;
        reqParams.cli['--max-items'] = jsonRequestBody.params.maxResults;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'ListThreatIntelSets',
                'boto3': 'list_threat_intel_sets',
                'cli': 'list-threat-intel-sets'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:iam.ListPolicyVersions
    // modified for policyarn split
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/iam$/g) && jsonRequestBody.operation == "ListPolicyVersions" && jsonRequestBody.method == "POST") {
        reqParams.boto3['PolicyArn'] = jsonRequestBody.contentString.match(/PolicyArn\=(.+)\&Version/g)[1];
        reqParams.cli['--policy-arn'] = jsonRequestBody.contentString.match(/PolicyArn\=(.+)\&Version/g)[1]; // "Action=ListPolicyVersions&PolicyArn=arn:aws:iam::aws:policy/aws-service-role/AmazonGuardDutyServiceRolePolicy&Version=2010-05-08"

        outputs.push({
            'region': region,
            'service': 'iam',
            'method': {
                'api': 'ListPolicyVersions',
                'boto3': 'list_policy_versions',
                'cli': 'list-policy-versions'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.CreateIPSet
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "CreateIPSet" && jsonRequestBody.method == "POST") {
        reqParams.boto3['DetectorId'] = jsonRequestBody.path;
        reqParams.cli['--detector-id'] = jsonRequestBody.path;
        reqParams.boto3['Name'] = jsonRequestBody.contentString.name;
        reqParams.cli['--name'] = jsonRequestBody.contentString.name;
        reqParams.boto3['Location'] = jsonRequestBody.contentString.location;
        reqParams.cli['--location'] = jsonRequestBody.contentString.location;
        reqParams.boto3['Format'] = jsonRequestBody.contentString.format;
        reqParams.cli['--format'] = jsonRequestBody.contentString.format;
        reqParams.boto3['Activate'] = jsonRequestBody.contentString.activate;
        reqParams.cli['--activate'] = jsonRequestBody.contentString.activate;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'CreateIPSet',
                'boto3': 'create_ip_set',
                'cli': 'create-ip-set'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.ListIPSets
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "ListIPSets" && jsonRequestBody.method == "GET") {
        reqParams.boto3['DetectorId'] =jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];
        reqParams.boto3['MaxResults'] = jsonRequestBody.params.maxResults;
        reqParams.cli['--max-items'] = jsonRequestBody.params.maxResults;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'ListIPSets',
                'boto3': 'list_ip_sets',
                'cli': 'list-ip-sets'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.GetIPSet
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "GetIPSet" && jsonRequestBody.method == "GET") {
        reqParams.boto3['IpSetId'] = jsonRequestBody.path.split("/")[4];
        reqParams.cli['--ip-set-id'] = jsonRequestBody.path.split("/")[4];
        reqParams.boto3['DetectorId'] = jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'GetIPSet',
                'boto3': 'get_ip_set',
                'cli': 'get-ip-set'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.UpdateIPSet
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "UpdateIPSet" && jsonRequestBody.method == "POST") {
        reqParams.boto3['IpSetId'] = jsonRequestBody.path.split("/")[4];
        reqParams.cli['--ip-set-id'] = jsonRequestBody.path.split("/")[4];
        reqParams.boto3['DetectorId'] =jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];
        reqParams.boto3['Activate'] = jsonRequestBody.contentString.activate;
        reqParams.cli['--activate'] = jsonRequestBody.contentString.activate;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'UpdateIPSet',
                'boto3': 'update_ip_set',
                'cli': 'update-ip-set'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.ArchiveFindings
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "ArchiveFindings" && jsonRequestBody.method == "POST") {
        reqParams.boto3['DetectorId'] = jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];
        reqParams.boto3['FindingIds'] = jsonRequestBody.contentString.findingIds;
        reqParams.cli['--finding-ids'] = jsonRequestBody.contentString.findingIds;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'ArchiveFindings',
                'boto3': 'archive_findings',
                'cli': 'archive-findings'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.UnarchiveFindings
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "UnarchiveFindings" && jsonRequestBody.method == "POST") {
        reqParams.boto3['DetectorId'] = jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];
        reqParams.boto3['FindingIds'] = jsonRequestBody.contentString.findingIds;
        reqParams.cli['--finding-ids'] = jsonRequestBody.contentString.findingIds;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'UnarchiveFindings',
                'boto3': 'unarchive_findings',
                'cli': 'unarchive-findings'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.GetFindings
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "GetFindings" && jsonRequestBody.method == "POST") {
        reqParams.boto3['DetectorId'] = jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];
        reqParams.boto3['FindingIds'] = jsonRequestBody.contentString.findingIds;
        reqParams.cli['--finding-ids'] = jsonRequestBody.contentString.findingIds;
        reqParams.boto3['SortCriteria'] = jsonRequestBody.contentString.sortCriteria;
        reqParams.cli['--sort-criteria'] = jsonRequestBody.contentString.sortCriteria;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'GetFindings',
                'boto3': 'get_findings',
                'cli': 'get-findings'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:iam.ListAttachedRolePolicies
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/iam$/g) && jsonRequestBody.operation == "ListAttachedRolePolicies" && jsonRequestBody.method == "POST") {
        reqParams.boto3['RoleName'] = jsonRequestBody.contentString.match(/RoleName\=(.+)\&Version/g)[1];;
        reqParams.cli['--role-name'] = jsonRequestBody.contentString.match(/RoleName\=(.+)\&Version/g)[1];;

        outputs.push({
            'region': region,
            'service': 'iam',
            'method': {
                'api': 'ListAttachedRolePolicies',
                'boto3': 'list_attached_role_policies',
                'cli': 'list-attached-role-policies'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.CreateSampleFindings
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "CreateSampleFindings" && jsonRequestBody.method == "POST") {
        reqParams.boto3['DetectorId'] = jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'CreateSampleFindings',
                'boto3': 'create_sample_findings',
                'cli': 'create-sample-findings'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:guardduty:guardduty.UpdateDetector
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/guardduty\/api\/guardduty$/g) && jsonRequestBody.operation == "UpdateDetector" && jsonRequestBody.method == "POST") {
        reqParams.boto3['DetectorId'] = jsonRequestBody.path.split("/")[2];
        reqParams.cli['--detector-id'] = jsonRequestBody.path.split("/")[2];
        reqParams.boto3['Enable'] = jsonRequestBody.contentString.enable;
        reqParams.cli['--enable'] = jsonRequestBody.contentString.enable;
        reqParams.boto3['FindingPublishingFrequency'] = jsonRequestBody.contentString.findingPublishingFrequency;
        reqParams.cli['--finding-publishing-frequency'] = jsonRequestBody.contentString.findingPublishingFrequency;

        outputs.push({
            'region': region,
            'service': 'guardduty',
            'method': {
                'api': 'UpdateDetector',
                'boto3': 'update_detector',
                'cli': 'update-detector'
            },
            'options': reqParams
        });
        
        return {};
    }

    // autogen:efs:efs.CreateTags
    // autogen:efs:efs.DeleteTags
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/efs\/ajax\/api\?/g) && getUrlValue(details.url, 'type') == "modifyTags") {
        reqParams.boto3['FileSystemId'] = jsonRequestBody.fileSystemId;
        reqParams.cli['--file-system-id'] = jsonRequestBody.fileSystemId;
        if (jsonRequestBody.addTags.length) {
            reqParams.boto3['Tags'] = jsonRequestBody.addTags;
            reqParams.cli['--tags'] = jsonRequestBody.addTags;

            outputs.push({
                'region': region,
                'service': 'efs',
                'method': {
                    'api': 'CreateTags',
                    'boto3': 'create_tags',
                    'cli': 'create-tags'
                },
                'options': reqParams
            });
        }
        if (jsonRequestBody.removeKeys.length) {
            reqParams.boto3['TagKeys'] = jsonRequestBody.removeKeys;
            reqParams.cli['--tag-keys'] = jsonRequestBody.removeKeys;

            outputs.push({
                'region': region,
                'service': 'efs',
                'method': {
                    'api': 'DeleteTags',
                    'boto3': 'delete_tags',
                    'cli': 'delete-tags'
                },
                'options': reqParams
            });
        }
        
        return {};
    }

    // autogen:efs:efs.ModifyMountTargetSecurityGroups
    if (details.method == "POST" && details.url.match(/.+console\.aws\.amazon\.com\/efs\/ajax\/api\?/g) && getUrlValue(details.url, 'type') == "modifySecurityGroups") {
        reqParams.boto3['MountTargetId'] = jsonRequestBody.mountTargetId;
        reqParams.cli['--mount-target-id'] = jsonRequestBody.mountTargetId;
        reqParams.boto3['SecurityGroups'] = jsonRequestBody.securityGroups;
        reqParams.cli['--security-groups'] = jsonRequestBody.securityGroups;

        outputs.push({
            'region': region,
            'service': 'efs',
            'method': {
                'api': 'ModifyMountTargetSecurityGroups',
                'boto3': 'modify_mount_target_security_groups',
                'cli': 'modify-mount-target-security-groups'
            },
            'options': reqParams
        });
        
        return {};
    }
    
    return false;
}
