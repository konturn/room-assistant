import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleInit
} from '@nestjs/common';
import { Entity } from '../../entities/entity.entity';
import { Sensor } from '../../entities/sensor.entity';
import { EntityConfig } from './entity-config';
import { SensorConfig } from './sensor-config';
import * as _ from 'lodash';
import { ConfigService } from '../../config/config.service';
import mqtt, { AsyncMqttClient } from 'async-mqtt';
import { HomeAssistantConfig } from './home-assistant.config';
import { Device } from './device';
import { system } from 'systeminformation';
import { EntityOptions } from '../../entities/entity-options.entity';
import { InjectEventEmitter } from 'nest-emitter';
import { EntitiesEventEmitter } from '../../entities/entities.events';

const PROPERTY_BLACKLIST = ['component', 'configTopic'];

@Injectable()
export class HomeAssistantService
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  private config: HomeAssistantConfig;
  private device: Device;
  private entityConfigs: Map<string, EntityConfig> = new Map<
    string,
    EntityConfig
  >();
  private debounceFunctions: Map<string, () => void> = new Map<
    string,
    () => void
  >();
  private mqttClient: AsyncMqttClient;
  private readonly logger: Logger = new Logger(HomeAssistantService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectEventEmitter() private readonly emitter: EntitiesEventEmitter
  ) {
    this.config = this.configService.get('homeAssistant');
  }

  onModuleInit(): void {
    this.emitter.on('newEntity', this.handleNewEntity.bind(this));
    this.emitter.on('stateUpdate', this.handleNewState.bind(this));
    this.emitter.on('attributesUpdate', this.handleNewAttributes.bind(this));
  }

  async onApplicationBootstrap(): Promise<void> {
    this.mqttClient = mqtt.connect(
      this.config.mqttUrl,
      this.config.mqttOptions
    );

    const systemInfo = await system();
    this.device = new Device(systemInfo.uuid);
    this.device.name = this.configService.get('global').instanceName;
    this.device.model = systemInfo.model;
    this.device.manufacturer = systemInfo.manufacturer;
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.entityConfigs.forEach(config => {
      this.mqttClient.publish(
        config.availabilityTopic,
        config.payloadNotAvailable
      );
    });
    return this.mqttClient.end();
  }

  handleNewEntity(entity: Entity, entityOptions?: EntityOptions): void {
    const combinedId = this.getCombinedId(entity.id, entity.distributed);
    let config: EntityConfig;
    if (entity instanceof Sensor) {
      config = new SensorConfig(combinedId, entity.name);
    } else {
      this.logger.warn(
        `${combinedId} cannot be matched to a Home Assistant type and will not be transferred`
      );
      return;
    }

    if (entityOptions !== undefined) {
      Object.assign(config, entityOptions.homeAssistant);
    }

    if (entity.distributed) {
      config.device = new Device('room-assistant-distributed');
      config.device.name = 'room-assistant hub';
    } else {
      config.device = this.device;
    }

    this.entityConfigs.set(combinedId, config);

    this.mqttClient.publish(
      config.configTopic,
      JSON.stringify(this.formatMessage(config)),
      {
        qos: 0,
        retain: true
      }
    );
    this.mqttClient.publish(config.availabilityTopic, config.payloadAvailable);
  }

  handleNewState(
    id: string,
    state: number | string | boolean,
    distributed: boolean = false
  ): void {
    const config = this.entityConfigs.get(this.getCombinedId(id, distributed));
    if (config === undefined) {
      return;
    }

    this.mqttClient.publish(config.stateTopic, String(state));
  }

  handleNewAttributes(
    entityId: string,
    attributes: { [key: string]: any },
    distributed: boolean = false
  ): void {
    const config = this.entityConfigs.get(
      this.getCombinedId(entityId, distributed)
    );
    if (config === undefined) {
      return;
    }

    if (this.debounceFunctions.has(entityId)) {
      this.debounceFunctions.get(entityId)();
    } else {
      const debouncedFunc = _.debounce(() => {
        this.mqttClient.publish(
          config.jsonAttributesTopic,
          JSON.stringify(this.formatMessage(attributes))
        );
      });
      this.debounceFunctions.set(entityId, debouncedFunc);
    }
  }

  protected getCombinedId(
    entityId: string,
    distributed: boolean = false
  ): string {
    return `${
      distributed
        ? 'distributed'
        : this.configService.get('global').instanceName
    }_${entityId}`;
  }

  private formatMessage(message: object): object {
    const filteredMessage = _.omit(message, PROPERTY_BLACKLIST);
    return this.deepMap(filteredMessage, obj => {
      return _.mapKeys(obj, (v, k) => {
        return _.snakeCase(k);
      });
    });
  }

  private deepMap(obj: object, mapper: (v: object) => object): object {
    return mapper(
      _.mapValues(obj, v => {
        return _.isObject(v) && !_.isArray(v) ? this.deepMap(v, mapper) : v;
      })
    );
  }
}