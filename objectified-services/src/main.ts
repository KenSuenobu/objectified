import {NestFactory} from '@nestjs/core';
import {DocumentBuilder, SwaggerModule} from '@nestjs/swagger';
import {Logger} from '@nestjs/common';
import {AppModule} from './app.module';

(async () => {
  const SERVER_PORT = process.env.SERVER_PORT ?? 3001;
  const SWAGGER_PATH = process.env.SWAGGER_PATH ?? 'swagger';

  const app = await NestFactory.create(AppModule);
  const config = new DocumentBuilder()
    .setTitle('objectified-db')
    .setVersion('0.1')
    .setExternalDoc('Objectified Documentation', 'https://www.objectified.dev/docs/')
    .addTag('namespaces', 'Namespace services', {
      description: 'Namespace Documentation and Suggestions',
      url: 'https://www.objectified.dev/docs/Namespace',
    })
    .addTag('classes', 'Handles classes definitions', {
      description: 'Classes Documentation',
      url: 'https://www.objectified.dev/docs/Class',
    })
    .addTag('data-types', 'Handles data types', {
      description: 'Data Types Documentation',
      url: 'https://www.objectified.dev/docs/DataType',
    })
    .addTag('fields', 'Handles data fields', {
      description: 'Field Documentation',
      url: 'https://www.objectified.dev/docs/Field',
    })
    .addTag('properties', 'Handles properties', {
      description: 'Properties Documentation',
      url: 'https://www.objectified.dev/docs/Property',
    })
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(SWAGGER_PATH, app, document);
  const logger = new Logger('main');

  await app.listen(SERVER_PORT)
    .then(() => {
      console.log('       _     _           _   _  __ _          _           _ _     \n' +
        '  ___ | |__ (_) ___  ___| |_(_)/ _(_) ___  __| |       __| | |__  \n' +
        ' / _ \\| \'_ \\| |/ _ \\/ __| __| | |_| |/ _ \\/ _` |_____ / _` | \'_ \\ \n' +
        '| (_) | |_) | |  __/ (__| |_| |  _| |  __/ (_| |_____| (_| | |_) |\n' +
        ' \\___/|_.__// |\\___|\\___|\\__|_|_| |_|\\___|\\__,_|      \\__,_|_.__/ \n' +
        '          |__/                                                    ')
      logger.log(`Listening for connections on http://localhost:${SERVER_PORT}`);
    });
})();
