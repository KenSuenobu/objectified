import React from 'react';
import {Button} from '@mui/material';
import { StackItem } from './StackItem';
import Typography from '@mui/material/Typography';
import {spacing} from '@mui/system';

export interface ListHeaderProps {
  header: string,
  onAdd: () => any,
}

const ListHeader = (props: ListHeaderProps) => {
  const onAddClicked = () => {
    console.log('On Add Clicked');
    props.onAdd();
  }

  return (
    <>
      <StackItem sx={{ width: '90%', textAlign: 'left', backgroundColor: '#ddd' }}>
        <Typography fontWeight={'bold'} sx={{ color: 'black', verticalAlign: 'middle' }}>
          {props.header}
        </Typography>
      </StackItem>
      <StackItem sx={{ width: '10%', textAlign: 'right' }}>
        <Button onClick={onAddClicked}>+</Button>
      </StackItem>
    </>
  );
};

export default ListHeader;