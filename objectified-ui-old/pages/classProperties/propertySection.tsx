import React, {useState} from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary, Button,
  Dialog, DialogActions,
  DialogContent,
  DialogTitle, FormControl, InputLabel, Select, SelectChangeEvent, Table, TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography
} from "@mui/material";
import {Delete, EditOutlined, ExpandMoreOutlined} from "@mui/icons-material";
import LoadingMessage from "../../components/LoadingMessage";
import axios from "axios";
import {Box, Stack} from "@mui/system";
import {StackItem} from "../../components/StackItem";
import MenuItem from "@mui/material/MenuItem";
import {errorDialog} from "../../components/dialogs/ConfirmDialog";

export interface PropertySectionProps {
  id: number;
  name: string;
  description: string;
  properties: any[];
}

const PropertySection = (props: PropertySectionProps) => {
  const [open, setOpen] = useState(false);
  const [classProperties, setClassProperties] = useState([]);
  const [propertyId, setPropertyId] = useState(0);
  const handlePropertyIdChanged = (event: SelectChangeEvent) => {
    setPropertyId(event.target.value as number);
  }

  const classPropertiesList = () => {
    if (classProperties.length === 0) {
      return (
        <>
          <Stack direction={'row'}>
            <StackItem sx={{ width: '90%', padding: '1em', color: '#000' }}>
              <Typography>
                No properties have been added to this class.
              </Typography>
            </StackItem>

            <StackItem sx={{ textAlign: 'right', padding: '1em', width: '10%' }}>
              <Button onClick={() => setOpen(true)} variant={'outlined'}>Add</Button>
            </StackItem>
          </Stack>
        </>
      );
    }

    return (
      <TableContainer component={Box}>
        <Table sx={{ minWidth: 650, backgroundColor: '#fff' }} aria-label={'namespace table'}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 'bold' }}>Property</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>Description</TableCell>
              <TableCell sx={{ textAlign: 'right' }}>
                <Button onClick={() => setOpen(true)} variant={'outlined'}>Add</Button>
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {classProperties.map((x) => (<>
              <TableRow>
                <TableCell>{x.name}</TableCell>
                <TableCell>{x.description}</TableCell>
                <TableCell align={'right'}><EditOutlined/> <Delete sx={{ color: 'red' }}/></TableCell>
              </TableRow>
            </>))}
          </TableBody>
        </Table>
      </TableContainer>
    );
  }

  const reloadPropertiesList = () => {
    axios.get(`/app/class-properties/get/${props.id}`)
      .then((result) => {
        const propertyList = result.data.propertyList ?? [];

        setClassProperties(propertyList);
      });
  }

  const handleAccordionChange = () => (event: React.SyntheticEvent, expanded: boolean) => {
    console.log(`Panel: ${props.id} expanded=${expanded}`);

    if (expanded) {
      reloadPropertiesList();
    }
  }

  const addClassPropertyClicked = () => {
    if (propertyId === 0) {
      return errorDialog('Please select a property to assign to the selected class.');
    }

    axios.put(`/app/class-properties/add/${props.id}/${propertyId}`)
      .then((x) => {
        setOpen(false);
        reloadPropertiesList();
      })
      .catch((x) => {
        errorDialog(x.message);
      });
  }

  return (
    <>
      <Dialog open={open} maxWidth={'sm'} fullWidth>
        <DialogTitle>Class Property</DialogTitle>
        <DialogContent>
          <Stack direction={'column'} sx={{padding: '1em'}}>
            <StackItem sx={{width: '100%', padding: '4px'}}>
              <FormControl fullWidth required>
                <InputLabel id={'property-label'} required>Property</InputLabel>
                <Select labelId={'property-label'} id={'property_id'} label={'Property'}
                        onChange={handlePropertyIdChanged}>
                  {props.properties.map((x) => (
                    <MenuItem value={x.id}>{x.name} ({x.description})</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </StackItem>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => addClassPropertyClicked()} variant={'contained'}>Add</Button>
          <Button onClick={() => setOpen(false)} variant={'contained'}
                  color={'error'}>Cancel</Button>
        </DialogActions>
      </Dialog>

      <Accordion onChange={handleAccordionChange()}>
        <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
          <Typography>
            <b>{props.name}</b> ({props.description})
          </Typography>
        </AccordionSummary>
        <AccordionDetails>
          {classPropertiesList()}
        </AccordionDetails>
      </Accordion>
    </>
  );
}

export default PropertySection;
