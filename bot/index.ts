import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputApplicationCommandData,
  Client,
  CommandInteraction,
  Events,
  GatewayIntentBits,
  GuildMemberRoleManager,
} from "discord.js";
import * as k8s from "@kubernetes/client-node";
import { randomBytes } from "node:crypto";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sCore = kc.makeApiClient(k8s.CoreV1Api);
const k8sNetworking = kc.makeApiClient(k8s.NetworkingV1Api);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

interface Command extends ChatInputApplicationCommandData {
  run: (interaction: CommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

const createKubernetesResources = async (id: string, password: string) => {
  await k8sCore.createNamespacedService({
    namespace: "tag",
    body: {
      metadata: {
        name: `${id}-writable`,
        labels: {
          app: `${id}-writable`,
          tag: "true",
        },
      },
      spec: {
        type: "ClusterIP",
        selector: {
          app: id,
        },
        ports: [
          {
            name: "writable",
            protocol: "TCP",
            port: 7681,
            targetPort: 7681,
          },
        ],
      },
    },
  });

  await k8sCore.createNamespacedService({
    namespace: "tag",
    body: {
      metadata: {
        name: `${id}-viewable`,
        labels: {
          app: `${id}-viewable`,
          tag: "true",
        },
      },
      spec: {
        type: "ClusterIP",
        selector: {
          app: id,
        },
        ports: [
          {
            name: "viewable",
            protocol: "TCP",
            port: 7682,
            targetPort: 7682,
          },
        ],
      },
    },
  });

  await k8sNetworking.createNamespacedIngress({
    namespace: "tag",
    body: {
      metadata: {
        name: id,
        annotations: {
          "cert-manager.io/cluster-issuer": "letsencrypt-prod",
        },
        labels: {
          tag: "true",
        },
      },
      spec: {
        ingressClassName: "public",
        rules: [
          {
            host: "tag.osucyber.club",
            http: {
              paths: [
                {
                  path: `/${id}/view`,
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: `${id}-viewable`,
                      port: {
                        name: "viewable",
                      },
                    },
                  },
                },
                {
                  path: `/${id}`,
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: `${id}-writable`,
                      port: {
                        name: "writable",
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
        tls: [
          {
            hosts: ["tag.osucyber.club"],
            secretName: "tag-tls-certificate",
          },
        ],
      },
    },
  });

  await k8sCore.createNamespacedConfigMap({
    namespace: "tag",
    body: {
      metadata: {
        name: id,
        labels: {
          tag: "true",
        },
      },
      data: {
        "autotag.env": `TTYD_ID=${id}\nTTYD_PASSWORD=${password}\n`,
      },
    },
  });

  await k8sCore.createNamespacedPod({
    namespace: "tag",
    body: {
      metadata: {
        name: id,
        labels: {
          app: id,
          tag: "true",
          password,
        },
        annotations: {
          "io.kubernetes.cri-o.userns-mode": "auto:size=65536",
        },
      },
      spec: {
        runtimeClassName: "sysbox-runc",
        hostname: "cscosu",
        dnsPolicy: "None",
        dnsConfig: {
          nameservers: ["1.1.1.1"],
        },
        containers: [
          {
            name: "workspace",
            image: "ghcr.io/cscosu/tag-archlinux:latest",
            imagePullPolicy: "Always",
            volumeMounts: [
              {
                name: "ttyd-config",
                mountPath: "/etc/autotag.env",
                subPath: "autotag.env",
              },
            ],
            resources: {
              limits: {
                cpu: "500m",
                memory: "2048Mi",
              },
              requests: {
                cpu: "10m",
                memory: "128Mi",
              },
            },
          },
        ],
        volumes: [
          {
            name: "ttyd-config",
            configMap: {
              name: id,
            },
          },
        ],
      },
    },
  });
};

const startTagCommand: Command = {
  name: "tag",
  description: "Tag subcommands",
  dmPermission: false,
  options: [
    {
      name: "start",
      type: ApplicationCommandOptionType.Subcommand,
      description: "Start a game of tag",
      options: [
        {
          name: "player1",
          type: ApplicationCommandOptionType.User,
          description: "The first player",
        },
        {
          name: "player2",
          type: ApplicationCommandOptionType.User,
          description: "The second player",
        },
        {
          name: "image",
          type: ApplicationCommandOptionType.String,
          choices: [{ name: "Arch Linux", value: "archlinux" }],
          description: "The image to use",
        },
      ],
    },
    {
      name: "end",
      type: ApplicationCommandOptionType.Subcommand,
      description: "End a game of tag",
    },
  ],
  async run(interaction) {
    const roles = interaction.member?.roles as GuildMemberRoleManager;
    // only admin role can run this command
    if (!roles.cache.some((role) => role.id === "796887971512320040")) {
      await interaction.reply({
        content: "You do not have permission to run this command!",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    if (interaction.options.data.some((option) => option.name === "end")) {
      const pods = await k8sCore.listNamespacedPod({ namespace: "tag" });
      pods.items.forEach(async (pod) => {
        if (pod.metadata?.labels?.tag === "true") {
          await k8sCore.deleteNamespacedPod({
            name: pod.metadata.name!,
            namespace: "tag",
          });
        }
      });

      const services = await k8sCore.listNamespacedService({
        namespace: "tag",
      });
      services.items.forEach(async (service) => {
        if (service.metadata?.labels?.tag === "true") {
          await k8sCore.deleteNamespacedService({
            name: service.metadata.name!,
            namespace: "tag",
          });
        }
      });

      const ingresses = await k8sNetworking.listNamespacedIngress({
        namespace: "tag",
      });
      ingresses.items.forEach(async (ingress) => {
        if (ingress.metadata?.labels?.tag === "true") {
          await k8sNetworking.deleteNamespacedIngress({
            name: ingress.metadata.name!,
            namespace: "tag",
          });
        }
      });

      const configmaps = await k8sCore.listNamespacedConfigMap({
        namespace: "tag",
      });
      configmaps.items.forEach(async (configmap) => {
        if (configmap.metadata?.labels?.tag === "true") {
          await k8sCore.deleteNamespacedConfigMap({
            name: configmap.metadata.name!,
            namespace: "tag",
          });
        }
      });

      await interaction.editReply({
        content: "Ended all tag game sessions",
      });
    }

    if (interaction.options.data.some((option) => option.name === "start")) {
      const password1 = randomBytes(4).toString("hex");
      const password2 = randomBytes(4).toString("hex");

      await Promise.all([
        createKubernetesResources("tag1", password1),
        createKubernetesResources("tag2", password2),
      ]);

      await interaction.editReply({
        content: "Thanos carpet",
      });
    }
  },
};

const commands = [startTagCommand];

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set(commands);

  console.log(`${c.user.tag} is ready!`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) {
    const command = commands.find((c) => c.name === interaction.commandName);
    if (command && command.autocomplete)
      await command.autocomplete(interaction);
  }
  if (interaction.isCommand()) {
    const command = commands.find((c) => c.name === interaction.commandName);
    if (command) await command.run(interaction);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
